from dotenv import load_dotenv
from fastapi import FastAPI, Request, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi import WebSocket, WebSocketDisconnect
from starlette.types import ASGIApp, Scope, Receive, Send
from typing import List
import json
from pathlib import Path
import os
import logging
import time
from contextlib import asynccontextmanager

# Importar módulos optimizados
from .database import init_db, health_check, get_pool_status, query_cache
from .routers import participants, voting, auth_routes, admin
from .auth.auth import create_default_admin_from_env

# Configurar logging optimizado
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Cargar variables de entorno
env_path = Path(__file__).resolve().parent.parent / ".env"
load_dotenv(dotenv_path=env_path)

# ================================
# CONFIGURACIÓN OPTIMIZADA
# ================================

# Configuración para 400+ usuarios simultáneos
PERFORMANCE_CONFIG = {
    'max_request_size': 16 * 1024 * 1024,  # 16MB
    'timeout_keep_alive': 30,
    'timeout_graceful_shutdown': 30,
    'limit_concurrency': 400,  # Límite de concurrencia
    'gzip_min_size': 1024,
    'cache_control_max_age': 3600,
}

# Middleware de monitoreo de rendimiento CORREGIDO
class PerformanceMiddleware:
    def __init__(self, app: ASGIApp):
        self.app = app
        self.request_times = []
        self.request_count = 0
        
    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http":
            start_time = time.time()
            
            async def send_wrapper(message):
                if message["type"] == "http.response.start":
                    duration = time.time() - start_time
                    self.request_times.append(duration)
                    self.request_count += 1
                    
                    # Log requests lentas (>2 segundos)
                    if duration > 2.0:
                        logger.warning(f"Slow request: {scope.get('path', 'unknown')} took {duration:.2f}s")
                    
                    # Mantener solo últimas 1000 mediciones
                    if len(self.request_times) > 1000:
                        self.request_times = self.request_times[-500:]
                
                await send(message)
            
            await self.app(scope, receive, send_wrapper)
        else:
            await self.app(scope, receive, send)

# Context manager para startup/shutdown
@asynccontextmanager
async def lifespan(app: FastAPI):
    """Gestión del ciclo de vida de la aplicación"""
    # Startup
    logger.info("🚀 Iniciando aplicación de votación...")
    
    try:
        # Inicializar base de datos
        init_db()
        
        # Crear administrador por defecto
        create_default_admin_from_env()
        
        # Verificar salud del sistema
        health = health_check()
        if health["status"] != "healthy":
            logger.warning(f"Sistema iniciado con advertencias: {health}")
        else:
            logger.info("✅ Sistema de votación iniciado correctamente")
            
        # Log de configuración
        pool_status = get_pool_status()
        logger.info(f"Pool de conexiones: {pool_status}")
        
        # Log adicional de startup
        logger.info("=" * 60)
        logger.info("🗳️  SISTEMA DE VOTACIÓN PARA ASAMBLEAS")
        logger.info("=" * 60)
        logger.info(f"Versión: 2.0.0")
        logger.info(f"Entorno: {'Producción (Railway)' if os.getenv('RAILWAY_ENVIRONMENT') else 'Desarrollo'}")
        logger.info(f"Optimizado para: {PERFORMANCE_CONFIG['limit_concurrency']}+ usuarios simultáneos")
        logger.info(f"Pool de BD: {get_pool_status()}")
        logger.info("=" * 60)
        
        yield
        
    except Exception as e:
        logger.error(f"❌ Error durante el startup: {e}")
        raise
    
    # Shutdown
    logger.info("🔄 Cerrando aplicación de votación...")
    try:
        # Limpiar cache
        query_cache.clear()
        logger.info("✅ Aplicación cerrada correctamente")
    except Exception as e:
        logger.error(f"Error durante shutdown: {e}")

# Crear aplicación FastAPI optimizada
app = FastAPI(
    title="Sistema de Votación - Asambleas",
    description="Sistema completo de votación para asambleas de conjuntos residenciales",
    version="2.0.0",
    lifespan=lifespan,
    docs_url="/docs" if os.getenv("DEBUG") == "1" else None,
    redoc_url="/redoc" if os.getenv("DEBUG") == "1" else None,
)

class ConnectionManager:
    def __init__(self):
        self.active_connections: List[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)
        logger.info(f"Admin conectado via WebSocket. Total: {len(self.active_connections)}")

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)
        logger.info(f"Admin desconectado. Total: {len(self.active_connections)}")

    async def broadcast(self, message: dict):
        """Enviar mensaje a todos los administradores conectados"""
        disconnected = []
        for connection in self.active_connections:
            try:
                await connection.send_text(json.dumps(message))
            except:
                disconnected.append(connection)
        
        # Limpiar conexiones muertas
        for conn in disconnected:
            self.disconnect(conn)

manager = ConnectionManager()

# ================================
# MIDDLEWARE OPTIMIZADO PARA ALTA CARGA
# ================================

# Seguridad - Trusted hosts
if os.getenv("RAILWAY_ENVIRONMENT"):
    app.add_middleware(
        TrustedHostMiddleware,
        allowed_hosts=[
            "*.railway.app",
            "*.up.railway.app", 
            "web-production-b3d70.up.railway.app",
            "localhost",
            "127.0.0.1"
        ]
    )

# Compresión GZIP para reducir ancho de banda
app.add_middleware(
    GZipMiddleware,
    minimum_size=PERFORMANCE_CONFIG['gzip_min_size'],
    compresslevel=6  # Balanceado entre CPU y compresión
)

# CORS optimizado
if os.getenv("RAILWAY_ENVIRONMENT"):
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[
            "https://*.railway.app",
            "https://*.up.railway.app",
            "https://web-production-b3d70.up.railway.app"
        ],
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allow_headers=["*"],
        max_age=3600,  # Cache preflight por 1 hora
    )
else:
    # Desarrollo
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

# CORRECCIÓN: Agregar middleware de rendimiento personalizado
app.add_middleware(PerformanceMiddleware)

# ================================
# RUTAS DE SALUD Y MONITOREO
# ================================

@app.get("/health")
async def health_endpoint():
    """Endpoint de salud para monitoring y load balancers"""
    health = health_check()
    pool_status = get_pool_status()
    cache_stats = query_cache.get_stats()
    
    # Obtener estadísticas de rendimiento de manera segura
    performance_middleware_instance = None
    for middleware in app.user_middleware:
        if hasattr(middleware, 'cls') and middleware.cls == PerformanceMiddleware:
            performance_middleware_instance = middleware
            break
    
    if performance_middleware_instance and hasattr(performance_middleware_instance, 'request_times'):
        if performance_middleware_instance.request_times:
            avg_response_time = sum(performance_middleware_instance.request_times) / len(performance_middleware_instance.request_times)
            max_response_time = max(performance_middleware_instance.request_times)
            request_count = performance_middleware_instance.request_count
        else:
            avg_response_time = 0
            max_response_time = 0
            request_count = 0
    else:
        avg_response_time = 0
        max_response_time = 0
        request_count = 0
    
    status_code = 200 if health["status"] == "healthy" else 503
    
    return JSONResponse(
        status_code=status_code,
        content={
            "status": health["status"],
            "timestamp": time.time(),
            "database": health,
            "connection_pool": pool_status,
            "cache": cache_stats,
            "performance": {
                "requests_processed": request_count,
                "avg_response_time_ms": round(avg_response_time * 1000, 2),
                "max_response_time_ms": round(max_response_time * 1000, 2)
            },
            "version": "2.0.0"
        }
    )

@app.get("/metrics")
async def metrics_endpoint():
    """Endpoint de métricas para monitoreo avanzado"""
    if not os.getenv("ENABLE_METRICS"):
        raise HTTPException(status_code=404, detail="Metrics not enabled")
    
    # Obtener métricas de performance de manera segura
    recent_response_times = []
    total_requests = 0
    
    for middleware in app.user_middleware:
        if hasattr(middleware, 'cls') and middleware.cls == PerformanceMiddleware:
            if hasattr(middleware, 'request_times'):
                recent_response_times = middleware.request_times[-10:] if middleware.request_times else []
                total_requests = middleware.request_count
            break
    
    return {
        "database_pool": get_pool_status(),
        "cache": query_cache.get_stats(),
        "performance": {
            "total_requests": total_requests,
            "recent_response_times": recent_response_times
        }
    }

# ================================
# RUTAS DE LA API
# ================================

@app.get("/api")
async def api_status():
    """Status de la API"""
    return {
        "status": "API funcionando correctamente",
        "version": "2.0.0",
        "optimized_for": "400+ concurrent users"
    }

@app.websocket("/ws/admin")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        while True:
            # Recibir datos del admin
            data = await websocket.receive_text()
            message = json.loads(data)
            
            # Reenviar a todos los otros admins
            await manager.broadcast({
                "type": "sync",
                "data": message.get("data"),
                "timestamp": message.get("timestamp", time.time())
            })
            
    except WebSocketDisconnect:
        manager.disconnect(websocket)
    except Exception as e:
        logger.error(f"WebSocket error: {e}")
        manager.disconnect(websocket)

# FUNCIÓN HELPER para broadcast desde endpoints
async def broadcast_admin_update(update_type: str, data: dict = None):
    """Función para enviar actualizaciones desde cualquier endpoint"""
    message = {
        "type": "admin_update", 
        "update_type": update_type,
        "data": data or {},
        "timestamp": time.time()
    }
    await manager.broadcast(message)

# Incluir routers optimizados
app.include_router(auth_routes.router, prefix="/api")
app.include_router(participants.router, prefix="/api")
app.include_router(voting.router, prefix="/api")
app.include_router(admin.router, prefix="/api")

# ================================
# ARCHIVOS ESTÁTICOS OPTIMIZADOS
# ================================

# Ruta absoluta al frontend
frontend_path = Path(__file__).resolve().parent.parent / "frontend"

# Headers de cache optimizados
cache_headers = {
    "Cache-Control": f"public, max-age={PERFORMANCE_CONFIG['cache_control_max_age']}",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "X-XSS-Protection": "1; mode=block"
}

# Montar archivos estáticos con configuración optimizada
if frontend_path.exists():
    app.mount(
        "/static", 
        StaticFiles(directory=frontend_path, html=True),
        name="static"
    )
    
    @app.get("/")
    async def read_root():
        """Servir página principal con headers optimizados"""
        file_path = frontend_path / "index.html"
        if file_path.exists():
            return FileResponse(
                file_path,
                headers={
                    **cache_headers,
                    "Content-Type": "text/html; charset=utf-8"
                }
            )
        return JSONResponse(
            status_code=404,
            content={"error": "Frontend file not found"}
        )
    
    # Servir archivos específicos con cache optimizado
    @app.get("/styles.css")
    async def serve_css():
        file_path = frontend_path / "styles.css"
        if file_path.exists():
            return FileResponse(
                file_path,
                headers={
                    **cache_headers,
                    "Content-Type": "text/css; charset=utf-8"
                }
            )
        raise HTTPException(status_code=404, detail="CSS file not found")
    
    @app.get("/app.js")
    async def serve_js():
        file_path = frontend_path / "app.js"
        if file_path.exists():
            return FileResponse(
                file_path,
                headers={
                    **cache_headers,
                    "Content-Type": "application/javascript; charset=utf-8"
                }
            )
        raise HTTPException(status_code=404, detail="JS file not found")
    
    @app.get("/components.js")
    async def serve_components_js():
        file_path = frontend_path / "components.js"
        if file_path.exists():
            return FileResponse(
                file_path,
                headers={
                    **cache_headers,
                    "Content-Type": "application/javascript; charset=utf-8"
                }
            )
        raise HTTPException(status_code=404, detail="Components JS file not found")

else:
    logger.warning(f"⚠️ Carpeta frontend no encontrada en {frontend_path}")
    
    @app.get("/")
    async def fallback_root():
        return JSONResponse(
            status_code=503,
            content={
                "error": "Frontend not available",
                "message": "Los archivos del frontend no están disponibles"
            }
        )

# ================================
# MANEJO DE ERRORES OPTIMIZADO
# ================================

@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    """Manejo global de errores con logging"""
    logger.error(f"Unhandled exception: {exc}", exc_info=True)
    
    # No exponer detalles en producción
    if os.getenv("RAILWAY_ENVIRONMENT"):
        detail = "Internal server error"
    else:
        detail = str(exc)
    
    return JSONResponse(
        status_code=500,
        content={
            "error": "Internal Server Error",
            "detail": detail,
            "timestamp": time.time()
        }
    )

@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException):
    """Manejo optimizado de excepciones HTTP"""
    return JSONResponse(
        status_code=exc.status_code,
        content={
            "error": exc.detail,
            "status_code": exc.status_code,
            "timestamp": time.time()
        }
    )

# ================================
# CONFIGURACIÓN DE SERVIDOR
# ================================

# Configuración específica para Railway
if __name__ == "__main__":
    import uvicorn
    
    port = int(os.getenv("PORT", 8000))
    
    # Configuración optimizada para producción
    uvicorn_config = {
        "host": "0.0.0.0",
        "port": port,
        "workers": 1,  # Railway funciona mejor con 1 worker
        "loop": "uvloop",  # Loop más rápido
        "http": "httptools",  # Parser HTTP más rápido
        "limit_concurrency": PERFORMANCE_CONFIG['limit_concurrency'],
        "timeout_keep_alive": PERFORMANCE_CONFIG['timeout_keep_alive'],
        "timeout_graceful_shutdown": PERFORMANCE_CONFIG['timeout_graceful_shutdown'],
        "access_log": False,  # Desactivar access log para mayor rendimiento
        "server_header": False,  # No exponer información del servidor
    }
    
    # Configuraciones adicionales para desarrollo
    if not os.getenv("RAILWAY_ENVIRONMENT"):
        uvicorn_config.update({
            "reload": True,
            "access_log": True,
            "log_level": "debug"
        })
    
    logger.info(f"🚀 Iniciando servidor en puerto {port}")
    uvicorn.run("main:app", **uvicorn_config)