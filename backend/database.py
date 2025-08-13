import os
import sqlite3
import psycopg2
from psycopg2.extras import RealDictCursor
from psycopg2.pool import ThreadedConnectionPool
import threading
import logging
import atexit

# Configurar logging para debug
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

DB_NAME = "database.db"

# Pool de conexiones global
postgres_pool = None
pool_lock = threading.Lock()

def init_postgres_pool():
    """Inicializar pool de conexiones PostgreSQL solo una vez"""
    global postgres_pool
    
    # Double-check locking pattern
    if postgres_pool is not None:
        return
        
    with pool_lock:
        if postgres_pool is not None:  # Check again inside lock
            return
            
        database_url = os.getenv("DATABASE_URL")
        if not database_url:
            return
            
        # Normalizar URL si es necesario
        if database_url.startswith("postgresql://"):
            database_url = database_url.replace("postgresql://", "postgres://", 1)
        
        try:
            # Configuración optimizada para Railway
            minconn = int(os.getenv("DATABASE_POOL_SIZE", "2"))  # Conexiones siempre activas
            maxconn = int(os.getenv("DATABASE_MAX_CONNECTIONS", "5"))  # Máximo total
            
            logger.info(f"Inicializando pool PostgreSQL: min={minconn}, max={maxconn}")
            
            postgres_pool = ThreadedConnectionPool(
                minconn=minconn,
                maxconn=maxconn,
                dsn=database_url,
                cursor_factory=RealDictCursor
            )
            
            logger.info("✅ Pool de conexiones PostgreSQL inicializado")
            
        except Exception as e:
            logger.error(f"❌ Error inicializando pool PostgreSQL: {e}")
            postgres_pool = None

def get_db():
    """Obtener conexión a la base de datos (con pool para PostgreSQL)"""
    database_url = os.getenv("DATABASE_URL")
    
    if database_url:
        # PostgreSQL con pool
        if postgres_pool is None:
            init_postgres_pool()
        
        if postgres_pool is not None:
            try:
                # Obtener conexión del pool
                conn = postgres_pool.getconn()
                if conn:
                    # Verificar que la conexión esté activa
                    conn.autocommit = False
                    return conn
                else:
                    logger.warning("Pool devolvió conexión None")
            except Exception as e:
                logger.error(f"Error obteniendo conexión del pool: {e}")
        
        # Fallback: conexión directa si pool falla
        logger.warning("Usando conexión directa PostgreSQL (fallback)")
        if database_url.startswith("postgresql://"):
            database_url = database_url.replace("postgresql://", "postgres://", 1)
        
        try:
            conn = psycopg2.connect(database_url, cursor_factory=RealDictCursor)
            conn.autocommit = False
            return conn
        except Exception as e:
            logger.error(f"Error en conexión directa PostgreSQL: {e}")
            raise
    else:
        # SQLite en desarrollo local
        conn = sqlite3.connect(DB_NAME)
        conn.row_factory = sqlite3.Row
        return conn

def close_db(conn):
    """Cerrar conexión correctamente (devolver al pool si es PostgreSQL)"""
    if conn is None:
        return
        
    database_url = os.getenv("DATABASE_URL")
    
    if database_url and postgres_pool is not None:
        # PostgreSQL: devolver conexión al pool
        try:
            postgres_pool.putconn(conn)
            logger.debug("Conexión devuelta al pool")
        except Exception as e:
            logger.error(f"Error devolviendo conexión al pool: {e}")
            # Si falla, cerrar la conexión directamente
            try:
                conn.close()
            except:
                pass
    else:
        # SQLite o conexión directa: cerrar normalmente
        try:
            conn.close()
        except Exception as e:
            logger.error(f"Error cerrando conexión: {e}")

def execute_query(conn, query, params=(), fetchone=False, fetchall=False, commit=False):
    """Ejecutar query con manejo de errores mejorado"""
    if conn is None:
        raise Exception("Conexión a base de datos es None")
    
    # Detectar si es Postgres
    is_postgres = 'psycopg2' in str(type(conn))
    
    cur = None
    try:
        if is_postgres:
            # Reemplazar placeholders de SQLite (?) por %s
            query = query.replace("?", "%s")
            cur = conn.cursor()
            cur.execute(query, params)
        else:
            # SQLite
            cur = conn.cursor()
            cur.execute(query, params)
        
        result = None
        if fetchone:
            result = cur.fetchone()
        elif fetchall:
            result = cur.fetchall()
        
        if commit:
            conn.commit()
        
        return result
        
    except Exception as e:
        logger.error(f"Error ejecutando query: {e}")
        logger.error(f"Query: {query}")
        logger.error(f"Params: {params}")
        
        # Rollback en caso de error
        try:
            conn.rollback()
        except:
            pass
        
        raise
    finally:
        if cur:
            try:
                cur.close()
            except:
                pass

def init_db():
    """Inicializar base de datos con manejo de errores mejorado"""
    logger.info("Inicializando base de datos...")
    
    db = None
    try:
        db = get_db()
        
        # Detectar tipo de base de datos
        is_postgres = 'psycopg2' in str(type(db))
        logger.info(f"Tipo de BD detectado: {'PostgreSQL' if is_postgres else 'SQLite'}")
        
        if is_postgres:
            # Sintaxis PostgreSQL
            tables = [
                """
                CREATE TABLE IF NOT EXISTS participants (
                    code TEXT PRIMARY KEY,
                    name TEXT,
                    coefficient REAL,
                    has_voted INTEGER DEFAULT 0,
                    present INTEGER DEFAULT 0,
                    is_power BOOLEAN DEFAULT FALSE,
                    login_time TEXT
                )
                """,
                """
                CREATE TABLE IF NOT EXISTS users (
                    username TEXT PRIMARY KEY,
                    password_hash TEXT NOT NULL,
                    role TEXT NOT NULL CHECK (role IN ('admin', 'voter'))
                )
                """,
                """
                CREATE TABLE IF NOT EXISTS questions (
                    id SERIAL PRIMARY KEY,
                    text TEXT NOT NULL,
                    type TEXT NOT NULL CHECK (type IN ('yesno', 'multiple')),
                    active INTEGER DEFAULT 1,
                    closed INTEGER DEFAULT 0,
                    allow_multiple INTEGER DEFAULT 0,
                    max_selections INTEGER DEFAULT 1
                )
                """,
                """
                CREATE TABLE IF NOT EXISTS options (
                    id SERIAL PRIMARY KEY,
                    question_id INTEGER NOT NULL,
                    option_text TEXT NOT NULL,
                    FOREIGN KEY (question_id) REFERENCES questions(id)
                )
                """,
                """
                CREATE TABLE IF NOT EXISTS votes (
                    participant_code TEXT,
                    question_id INTEGER,
                    answer TEXT,
                    timestamp TEXT,
                    PRIMARY KEY (participant_code, question_id),
                    FOREIGN KEY (participant_code) REFERENCES participants(code),
                    FOREIGN KEY (question_id) REFERENCES questions(id)
                )
                """,
                """
                CREATE TABLE IF NOT EXISTS config (
                    key TEXT PRIMARY KEY,
                    value TEXT
                )
                """
            ]
        else:
            # Sintaxis SQLite
            tables = [
                """
                CREATE TABLE IF NOT EXISTS participants (
                    code TEXT PRIMARY KEY,
                    name TEXT,
                    coefficient REAL,
                    has_voted INTEGER DEFAULT 0,
                    present INTEGER DEFAULT 0,
                    is_power BOOLEAN DEFAULT 0,
                    login_time TEXT
                )
                """,
                """
                CREATE TABLE IF NOT EXISTS users (
                    username TEXT PRIMARY KEY,
                    password_hash TEXT NOT NULL,
                    role TEXT NOT NULL CHECK (role IN ('admin', 'voter'))
                )
                """,
                """
                CREATE TABLE IF NOT EXISTS questions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    text TEXT NOT NULL,
                    type TEXT NOT NULL CHECK (type IN ('yesno', 'multiple')),
                    active INTEGER DEFAULT 1,
                    closed INTEGER DEFAULT 0,
                    allow_multiple INTEGER DEFAULT 0,
                    max_selections INTEGER DEFAULT 1
                )
                """,
                """
                CREATE TABLE IF NOT EXISTS options (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    question_id INTEGER NOT NULL,
                    option_text TEXT NOT NULL,
                    FOREIGN KEY (question_id) REFERENCES questions(id)
                )
                """,
                """
                CREATE TABLE IF NOT EXISTS votes (
                    participant_code TEXT,
                    question_id INTEGER,
                    answer TEXT,
                    timestamp TEXT,
                    PRIMARY KEY (participant_code, question_id),
                    FOREIGN KEY (participant_code) REFERENCES participants(code),
                    FOREIGN KEY (question_id) REFERENCES questions(id)
                )
                """,
                """
                CREATE TABLE IF NOT EXISTS config (
                    key TEXT PRIMARY KEY,
                    value TEXT
                )
                """
            ]
        
        # Ejecutar creación de tablas
        cursor = db.cursor()
        for i, table_sql in enumerate(tables, 1):
            try:
                cursor.execute(table_sql)
                logger.debug(f"Tabla {i}/6 creada/verificada")
            except Exception as e:
                logger.error(f"Error creando tabla {i}: {e}")
                raise
        
        db.commit()
        cursor.close()
        logger.info("✅ Base de datos inicializada correctamente")
        
    except Exception as e:
        logger.error(f"❌ Error inicializando base de datos: {e}")
        raise
    finally:
        if db:
            close_db(db)

# Función de limpieza para cerrar pool al finalizar aplicación
def cleanup_connections():
    """Cerrar pool de conexiones al finalizar aplicación"""
    global postgres_pool
    if postgres_pool:
        try:
            postgres_pool.closeall()
            logger.info("Pool de conexiones cerrado")
        except Exception as e:
            logger.error(f"Error cerrando pool: {e}")

# Registrar limpieza al finalizar aplicación (opcional)
atexit.register(cleanup_connections)