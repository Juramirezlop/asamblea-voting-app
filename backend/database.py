import os
import psycopg2
from psycopg2.extras import RealDictCursor
from psycopg2.pool import ThreadedConnectionPool
import threading
import logging
import atexit

# Configurar logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

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
            raise Exception("DATABASE_URL no configurada. Este sistema requiere PostgreSQL.")
            
        # Normalizar URL si es necesario
        if database_url.startswith("postgresql://"):
            database_url = database_url.replace("postgresql://", "postgres://", 1)
        
        try:
            # Configuración más conservadora y realista
            minconn = int(os.getenv("DATABASE_POOL_SIZE", "2"))  # Mínimo razonable
            maxconn = int(os.getenv("DATABASE_MAX_CONNECTIONS", "8"))  # Máximo balanceado
            
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
            raise

def get_db():
    """Obtener conexión a la base de datos PostgreSQL"""
    if postgres_pool is None:
        init_postgres_pool()
    
    try:
        # Obtener conexión del pool
        conn = postgres_pool.getconn()
        if conn:
            # Verificar que la conexión esté activa
            conn.autocommit = False
            return conn
        else:
            logger.error("Pool devolvió conexión None")
            raise Exception("No se pudo obtener conexión del pool")
            
    except Exception as e:
        logger.error(f"Error obteniendo conexión del pool: {e}")
        
        # Fallback: conexión directa si pool falla
        logger.warning("Usando conexión directa PostgreSQL (fallback)")
        database_url = os.getenv("DATABASE_URL")
        
        if database_url.startswith("postgresql://"):
            database_url = database_url.replace("postgresql://", "postgres://", 1)
        
        try:
            conn = psycopg2.connect(database_url, cursor_factory=RealDictCursor)
            conn.autocommit = False
            return conn
        except Exception as fallback_error:
            logger.error(f"Error en conexión directa PostgreSQL: {fallback_error}")
            raise

def close_db(conn):
    """Cerrar conexión correctamente (devolver al pool)"""
    if conn is None:
        return
        
    if postgres_pool is not None:
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
        # Conexión directa: cerrar normalmente
        try:
            conn.close()
        except Exception as e:
            logger.error(f"Error cerrando conexión: {e}")

def execute_query(conn, query, params=(), fetchone=False, fetchall=False, commit=False):
    """Ejecutar query PostgreSQL con manejo de errores mejorado"""
    if conn is None:
        raise Exception("Conexión a base de datos es None")
    
    cur = None
    try:
        # Convertir placeholders SQLite a PostgreSQL si es necesario
        postgres_query = query.replace("?", "%s")
        # Manejar concatenación específica si aparece
        postgres_query = postgres_query.replace("CONCAT('%', o.option_text, '%')", "'%' || o.option_text || '%'")
        
        cur = conn.cursor()
        logger.debug(f"PostgreSQL Query: {postgres_query}")
        logger.debug(f"PostgreSQL Params: {params}")
        cur.execute(postgres_query, params)
        
        result = None
        if fetchone:
            result = cur.fetchone()
            # Convertir a dict si es necesario
            if result and hasattr(result, '_asdict'):
                result = dict(result)
        elif fetchall:
            result = cur.fetchall()
            # Convertir a lista de dicts si es necesario
            if result and hasattr(result[0], '_asdict'):
                result = [dict(row) for row in result]
        
        if commit:
            conn.commit()
        
        return result
        
    except Exception as e:
        logger.error(f"Error ejecutando query: {e}")
        logger.error(f"Query original: {query}")
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
    """Inicializar base de datos PostgreSQL"""
    logger.info("Inicializando base de datos PostgreSQL...")
    
    db = None
    try:
        db = get_db()
        
        # Tablas con sintaxis PostgreSQL optimizada
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
                FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS votes (
                participant_code TEXT,
                question_id INTEGER,
                answer TEXT,
                timestamp TEXT,
                PRIMARY KEY (participant_code, question_id),
                FOREIGN KEY (participant_code) REFERENCES participants(code) ON DELETE CASCADE,
                FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE
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
        logger.info("✅ Base de datos PostgreSQL inicializada correctamente")
        
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

# Registrar limpieza al finalizar aplicación
atexit.register(cleanup_connections)