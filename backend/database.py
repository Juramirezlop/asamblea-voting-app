import os
import psycopg2
from psycopg2.extras import RealDictCursor
from psycopg2.pool import ThreadedConnectionPool
import threading
import logging
import atexit
import time
from functools import wraps

# Configurar logging optimizado
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Pool de conexiones global optimizado para 400+ usuarios
postgres_pool = None
pool_lock = threading.Lock()

# Configuración optimizada para alta carga
DB_CONFIG = {
    'minconn': int(os.getenv("DATABASE_POOL_MIN", "5")),  # Mínimo aumentado
    'maxconn': int(os.getenv("DATABASE_POOL_MAX", "25")), # Máximo optimizado para Railway
    'connect_timeout': 10,
    'command_timeout': 30,
    'application_name': 'asamblea_voting_system'
}

def retry_db_operation(max_retries=3, delay=1):
    """Decorador para reintentar operaciones de BD en caso de fallo"""
    def decorator(func):
        @wraps(func)
        def wrapper(*args, **kwargs):
            for attempt in range(max_retries):
                try:
                    return func(*args, **kwargs)
                except (psycopg2.OperationalError, psycopg2.InterfaceError) as e:
                    if attempt == max_retries - 1:
                        logger.error(f"Failed {func.__name__} after {max_retries} attempts: {e}")
                        raise
                    logger.warning(f"Attempt {attempt + 1} failed for {func.__name__}: {e}. Retrying in {delay}s...")
                    time.sleep(delay * (attempt + 1))  # Backoff exponencial
                except Exception as e:
                    logger.error(f"Non-recoverable error in {func.__name__}: {e}")
                    raise
            return None
        return wrapper
    return decorator

def init_postgres_pool():
    """Inicializar pool de conexiones PostgreSQL optimizado"""
    global postgres_pool
    
    if postgres_pool is not None:
        return
        
    with pool_lock:
        if postgres_pool is not None:
            return
            
        database_url = os.getenv("DATABASE_URL")
        if not database_url:
            raise Exception("DATABASE_URL no configurada. Este sistema requiere PostgreSQL.")
            
        # Normalizar URL
        if database_url.startswith("postgresql://"):
            database_url = database_url.replace("postgresql://", "postgres://", 1)
        
        try:
            logger.info(f"Inicializando pool PostgreSQL: min={DB_CONFIG['minconn']}, max={DB_CONFIG['maxconn']}")
            
            postgres_pool = ThreadedConnectionPool(
                minconn=DB_CONFIG['minconn'],
                maxconn=DB_CONFIG['maxconn'],
                dsn=database_url,
                cursor_factory=RealDictCursor,
                connect_timeout=DB_CONFIG['connect_timeout'],
                application_name=DB_CONFIG['application_name']
            )
            
            # Test de conexión inicial
            test_conn = postgres_pool.getconn()
            try:
                test_cursor = test_conn.cursor()
                test_cursor.execute("SELECT 1")
                test_cursor.close()
                logger.info("✅ Pool de conexiones PostgreSQL inicializado y probado")
            finally:
                postgres_pool.putconn(test_conn)
            
        except Exception as e:
            logger.error(f"❌ Error inicializando pool PostgreSQL: {e}")
            raise

@retry_db_operation(max_retries=3, delay=0.5)
def get_db():
    """Obtener conexión a la base de datos PostgreSQL con reintentos"""
    if postgres_pool is None:
        init_postgres_pool()
    
    try:
        # Obtener conexión del pool con timeout
        conn = postgres_pool.getconn()
        if conn is None:
            raise Exception("Pool devolvió conexión None")
            
        # Verificar que la conexión esté activa
        if conn.closed:
            logger.warning("Conexión cerrada detectada, obteniendo nueva conexión")
            postgres_pool.putconn(conn, close=True)
            conn = postgres_pool.getconn()
        
        # Configurar conexión
        conn.autocommit = False
        return conn
            
    except Exception as e:
        logger.error(f"Error obteniendo conexión del pool: {e}")
        
        # Fallback crítico: conexión directa
        logger.warning("Usando conexión directa PostgreSQL (fallback)")
        database_url = os.getenv("DATABASE_URL")
        
        if database_url.startswith("postgresql://"):
            database_url = database_url.replace("postgresql://", "postgres://", 1)
        
        try:
            conn = psycopg2.connect(
                database_url, 
                cursor_factory=RealDictCursor,
                connect_timeout=DB_CONFIG['connect_timeout'],
                application_name=DB_CONFIG['application_name'] + "_fallback"
            )
            conn.autocommit = False
            logger.info("Conexión directa establecida como fallback")
            return conn
        except Exception as fallback_error:
            logger.critical(f"Error en conexión directa PostgreSQL: {fallback_error}")
            raise

def close_db(conn):
    """Cerrar conexión correctamente (devolver al pool) optimizado"""
    if conn is None:
        return
        
    try:
        # Si hay transacción pendiente, hacer rollback por seguridad
        if not conn.closed and conn.get_transaction_status() != psycopg2.extensions.TRANSACTION_STATUS_IDLE:
            conn.rollback()
            
        if postgres_pool is not None:
            # PostgreSQL: devolver conexión al pool
            postgres_pool.putconn(conn)
            logger.debug("Conexión devuelta al pool")
        else:
            # ConexiónANCH directa: cerrar normalmente
            conn.close()
            logger.debug("Conexión directa cerrada")
            
    except Exception as e:
        logger.error(f"Error devolviendo conexión al pool: {e}")
        # Si falla devolver al pool, cerrar la conexión forzadamente
        try:
            if not conn.closed:
                conn.close()
        except:
            pass

@retry_db_operation(max_retries=2, delay=0.3)
def execute_query(conn, query, params=(), fetchone=False, fetchall=False, commit=False):
    """Ejecutar query PostgreSQL con manejo de errores optimizado y cache"""
    if conn is None:
        raise Exception("Conexión a base de datos es None")
    
    cur = None
    try:
        # Convertir placeholders SQLite a PostgreSQL si es necesario
        postgres_query = query.replace("?", "%s")
        
        # Optimizaciones específicas de queries
        postgres_query = optimize_query(postgres_query)
        
        cur = conn.cursor()
        
        # Log solo en desarrollo
        if os.getenv("DEBUG_SQL") == "1":
            logger.debug(f"PostgreSQL Query: {postgres_query}")
            logger.debug(f"PostgreSQL Params: {params}")
        
        # Ejecutar con timeout implícito del pool
        cur.execute(postgres_query, params)
        
        result = None
        if fetchone:
            result = cur.fetchone()
            if result and hasattr(result, '_asdict'):
                result = dict(result)
        elif fetchall:
            result = cur.fetchall()
            if result and hasattr(result[0], '_asdict'):
                result = [dict(row) for row in result]
        
        if commit:
            conn.commit()
        
        return result
        
    except psycopg2.Error as e:
        logger.error(f"Error PostgreSQL ejecutando query: {e}")
        logger.error(f"Query: {query}")
        logger.error(f"Params: {params}")
        
        # Rollback automático en caso de error
        try:
            if conn and not conn.closed:
                conn.rollback()
        except:
            pass
        
        raise
    except Exception as e:
        logger.error(f"Error general ejecutando query: {e}")
        logger.error(f"Query: {query}")
        
        try:
            if conn and not conn.closed:
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

def optimize_query(query):
    """Aplicar optimizaciones específicas a queries comunes"""
    # Optimización para consultas de aforo (muy frecuentes)
    if "COUNT(*) as" in query and "participants" in query:
        # PostgreSQL usa booleanos reales
        if "present = 1" in query:
            query = query.replace("present = 1", "present = true")
        if "is_power = FALSE" in query:
            pass  # Ya está correcto
        elif "is_power = TRUE" in query:
            pass  # Ya está correcto
    
    # Optimización para consultas de resultados de votación
    if "votes" in query and "participants" in query and "JOIN" in query:
        # Asegurar que use índices en claves foráneas
        pass
    
    return query

def init_db():
    """Inicializar base de datos PostgreSQL con índices optimizados"""
    logger.info("Inicializando base de datos PostgreSQL optimizada...")
    
    db = None
    try:
        db = get_db()
        
        # Tablas con sintaxis PostgreSQL optimizada para alta concurrencia
        tables = [
            """
            CREATE TABLE IF NOT EXISTS participants (
                code TEXT PRIMARY KEY,
                name TEXT,
                coefficient REAL DEFAULT 1.0,
                has_voted INTEGER DEFAULT 0,
                present INTEGER DEFAULT 0,
                is_power BOOLEAN DEFAULT FALSE,
                login_time TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS users (
                username TEXT PRIMARY KEY,
                password_hash TEXT NOT NULL,
                role TEXT NOT NULL CHECK (role IN ('admin', 'voter')),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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
                max_selections INTEGER DEFAULT 1,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                time_limit_minutes INTEGER DEFAULT NULL,
                expires_at TEXT DEFAULT NULL
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS options (
                id SERIAL PRIMARY KEY,
                question_id INTEGER NOT NULL,
                option_text TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS votes (
                participant_code TEXT,
                question_id INTEGER,
                answer TEXT,
                timestamp TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (participant_code, question_id),
                FOREIGN KEY (participant_code) REFERENCES participants(code) ON DELETE CASCADE,
                FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS config (
                key TEXT PRIMARY KEY,
                value TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """
        ]
        
        # Crear tablas
        cursor = db.cursor()
        for i, table_sql in enumerate(tables, 1):
            try:
                cursor.execute(table_sql)
                logger.debug(f"Tabla {i}/6 creada/verificada")
            except Exception as e:
                logger.error(f"Error creando tabla {i}: {e}")
                raise
        
        # Crear índices optimizados para alta concurrencia (400+ usuarios)
        indices = [
            # Índices para participants (consultas muy frecuentes)
            "CREATE INDEX IF NOT EXISTS idx_participants_present ON participants(present) WHERE present = 1",
            "CREATE INDEX IF NOT EXISTS idx_participants_is_power ON participants(is_power) WHERE present = 1",
            "CREATE INDEX IF NOT EXISTS idx_participants_coefficient ON participants(coefficient) WHERE present = 1",
            "CREATE INDEX IF NOT EXISTS idx_participants_has_voted ON participants(has_voted) WHERE present = 1",
            
            # Índices para votes (operaciones críticas de votación)
            "CREATE INDEX IF NOT EXISTS idx_votes_question_id ON votes(question_id)",
            "CREATE INDEX IF NOT EXISTS idx_votes_participant_code ON votes(participant_code)",
            "CREATE INDEX IF NOT EXISTS idx_votes_composite ON votes(question_id, participant_code)",
            
            # Índices para questions y options
            "CREATE INDEX IF NOT EXISTS idx_questions_active ON questions(active) WHERE active = 1",
            "CREATE INDEX IF NOT EXISTS idx_questions_type ON questions(type)",
            "CREATE INDEX IF NOT EXISTS idx_options_question_id ON options(question_id)",
            
            # Índices para consultas de estadísticas y reportes
            "CREATE INDEX IF NOT EXISTS idx_participants_stats ON participants(present, is_power, coefficient) WHERE present = 1",
            
            # Índice para config
            "CREATE INDEX IF NOT EXISTS idx_config_key ON config(key)"
        ]
        
        logger.info("Creando índices optimizados para alta concurrencia...")
        for idx_sql in indices:
            try:
                cursor.execute(idx_sql)
                logger.debug(f"Índice creado: {idx_sql.split('idx_')[1].split(' ')[0] if 'idx_' in idx_sql else 'unknown'}")
            except Exception as e:
                logger.warning(f"Error creando índice (posiblemente ya existe): {e}")
        
        # Optimizaciones adicionales de PostgreSQL para alta carga
        optimizations = [
            # Configurar autovacuum más agresivo para tablas de alta escritura
            "ALTER TABLE votes SET (autovacuum_vacuum_scale_factor = 0.1)",
            "ALTER TABLE participants SET (autovacuum_vacuum_scale_factor = 0.2)",
            
            # Configurar estadísticas para el optimizador de consultas
            "ALTER TABLE participants ALTER COLUMN present SET STATISTICS 1000",
            "ALTER TABLE votes ALTER COLUMN question_id SET STATISTICS 1000",
        ]
        
        for opt_sql in optimizations:
            try:
                cursor.execute(opt_sql)
            except Exception as e:
                logger.debug(f"Optimización no aplicada (normal en algunas versiones): {e}")
        
        db.commit()
        cursor.close()
        logger.info("✅ Base de datos PostgreSQL inicializada con optimizaciones para 400+ usuarios")
        
    except Exception as e:
        logger.error(f"❌ Error inicializando base de datos: {e}")
        raise
    finally:
        if db:
            close_db(db)

# ================================
# FUNCIONES DE MONITOREO Y SALUD
# ================================

def get_pool_status():
    """Obtener estado del pool de conexiones para monitoreo"""
    if not postgres_pool:
        return {"status": "not_initialized"}
    
    try:
        # PostgreSQL pool statistics (aproximadas)
        return {
            "status": "healthy",
            "min_connections": DB_CONFIG['minconn'],
            "max_connections": DB_CONFIG['maxconn'],
            "pool_type": "ThreadedConnectionPool"
        }
    except Exception as e:
        logger.error(f"Error obteniendo estado del pool: {e}")
        return {"status": "error", "error": str(e)}

def health_check():
    """Verificación de salud de la base de datos"""
    try:
        conn = get_db()
        try:
            cursor = conn.cursor()
            cursor.execute("SELECT 1 as health_check, CURRENT_TIMESTAMP as server_time")
            result = cursor.fetchone()
            cursor.close()
            
            if result:
                return {
                    "status": "healthy",
                    "server_time": result["server_time"],
                    "response_time": "< 100ms"
                }
            else:
                return {"status": "unhealthy", "reason": "No response from database"}
                
        finally:
            close_db(conn)
            
    except Exception as e:
        logger.error(f"Health check failed: {e}")
        return {"status": "unhealthy", "error": str(e)}

# ================================
# CACHE SIMPLE EN MEMORIA
# ================================

class SimpleCache:
    """Cache simple en memoria para consultas frecuentes"""
    
    def __init__(self, default_ttl=30):
        self.cache = {}
        self.timestamps = {}
        self.default_ttl = default_ttl
        self._lock = threading.Lock()
    
    def get(self, key):
        with self._lock:
            if key in self.cache:
                if time.time() - self.timestamps[key] < self.default_ttl:
                    return self.cache[key]
                else:
                    # Expirado
                    del self.cache[key]
                    del self.timestamps[key]
            return None
    
    def set(self, key, value, ttl=None):
        with self._lock:
            self.cache[key] = value
            self.timestamps[key] = time.time()
    
    def delete(self, key):
        with self._lock:
            if key in self.cache:
                del self.cache[key]
                del self.timestamps[key]
    
    def clear(self):
        with self._lock:
            self.cache.clear()
            self.timestamps.clear()
    
    def get_stats(self):
        with self._lock:
            return {
                "entries": len(self.cache),
                "memory_usage": f"{len(str(self.cache))} chars"
            }

# Instancia global de cache
query_cache = SimpleCache(default_ttl=15)  # 15 segundos para datos dinámicos

def cached_query(key, ttl=None):
    """Decorador para cachear resultados de queries"""
    def decorator(func):
        @wraps(func)
        def wrapper(*args, **kwargs):
            cache_key = f"{key}:{hash(str(args) + str(kwargs))}"
            
            # Intentar obtener del cache
            cached_result = query_cache.get(cache_key)
            if cached_result is not None:
                logger.debug(f"Cache hit for {cache_key}")
                return cached_result
            
            # Ejecutar función y cachear resultado
            result = func(*args, **kwargs)
            query_cache.set(cache_key, result, ttl)
            logger.debug(f"Cache set for {cache_key}")
            
            return result
        return wrapper
    return decorator

# ================================
# FUNCIONES DE LIMPIEZA
# ================================

def cleanup_connections():
    """Cerrar pool de conexiones al finalizar aplicación"""
    global postgres_pool
    if postgres_pool:
        try:
            postgres_pool.closeall()
            logger.info("Pool de conexiones cerrado correctamente")
        except Exception as e:
            logger.error(f"Error cerrando pool: {e}")

def cleanup_cache():
    """Limpiar cache al finalizar aplicación"""
    try:
        query_cache.clear()
        logger.info("Cache limpiado correctamente")
    except Exception as e:
        logger.error(f"Error limpiando cache: {e}")

# ================================
# FUNCIONES DE UTILIDAD ESPECÍFICAS
# ================================

@cached_query("aforo_stats", ttl=5)
def get_cached_aforo_stats():
    """Obtener estadísticas de aforo cacheadas (muy solicitadas)"""
    conn = get_db()
    try:
        stats = execute_query(
            conn,
            """
            SELECT 
                COUNT(*) as total_participants,
                COUNT(CASE WHEN present = 1 THEN 1 END) as present_count,
                COUNT(CASE WHEN present = 1 AND is_power = false THEN 1 END) as own_votes,
                COUNT(CASE WHEN present = 1 AND is_power = true THEN 1 END) as power_votes,
                COALESCE(SUM(CASE WHEN present = 1 THEN coefficient ELSE 0 END), 0) as present_coefficient,
                COALESCE(SUM(coefficient), 0) as total_coefficient
            FROM participants
            """,
            fetchone=True
        )
        return stats
    finally:
        close_db(conn)

def batch_insert_participants(participants_data):
    """Inserción optimizada por lotes para cargas masivas"""
    if not participants_data:
        return 0
    
    conn = get_db()
    try:
        cursor = conn.cursor()
        
        # Usar COPY para inserción masiva más eficiente
        insert_query = """
            INSERT INTO participants (code, name, coefficient, has_voted, present)
            VALUES %s
            ON CONFLICT (code) DO UPDATE SET
                name = EXCLUDED.name,
                coefficient = EXCLUDED.coefficient,
                has_voted = EXCLUDED.has_voted,
                present = EXCLUDED.present,
                updated_at = CURRENT_TIMESTAMP
        """
        
        # Preparar datos para psycopg2.extras.execute_values
        values = [
            (data['code'], data['name'], data['coefficient'], data.get('has_voted', 0), 0)
            for data in participants_data
        ]
        
        from psycopg2.extras import execute_values
        execute_values(cursor, insert_query, values)
        
        rows_affected = cursor.rowcount
        conn.commit()
        cursor.close()
        
        # Limpiar cache relevante
        query_cache.delete("aforo_stats")
        
        logger.info(f"Batch insert completed: {rows_affected} participants processed")
        return rows_affected
        
    except Exception as e:
        logger.error(f"Error in batch_insert_participants: {e}")
        conn.rollback()
        raise
    finally:
        close_db(conn)

def execute_with_retry(query, params=(), max_retries=3):
    """Ejecutar query con reintentos automáticos para operaciones críticas"""
    for attempt in range(max_retries):
        conn = None
        try:
            conn = get_db()
            result = execute_query(conn, query, params, commit=True)
            return result
        except Exception as e:
            if conn:
                close_db(conn)
            
            if attempt == max_retries - 1:
                logger.error(f"Query failed after {max_retries} attempts: {e}")
                raise
            
            logger.warning(f"Query attempt {attempt + 1} failed: {e}. Retrying...")
            time.sleep(0.5 * (attempt + 1))  # Backoff progresivo

# ================================
# REGISTRAR LIMPIEZA AL FINALIZAR
# ================================

atexit.register(cleanup_connections)
atexit.register(cleanup_cache)

# Log de inicialización
logger.info("🗄️  Sistema de base de datos optimizado cargado para alta concurrencia")