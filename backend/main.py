from dotenv import load_dotenv
from fastapi import FastAPI, Request, HTTPException, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi import WebSocket, WebSocketDisconnect
from typing import List, Dict
import json
from pathlib import Path
import os
import logging
import time
from contextlib import asynccontextmanager

# Importar módulos optimizados
from .database import init_db, health_check, get_pool_status
from .routers import participants, voting, auth_routes, admin
from .auth.auth import create_default_admin_from_env, admin_required

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
# WEBSOCKET MANAGER
# ================================

class ConnectionManager:
    def __init__(self):
        self.admin_connections: List[WebSocket] = []
        self.voter_connections: Dict[str, WebSocket] = {}  # code -> websocket
        
    async def connect_admin(self, websocket: WebSocket):
        await websocket.accept()
        self.admin_connections.append(websocket)
        logger.info(f"Admin conectado. Total admins: {len(self.admin_connections)}")
        
    async def connect_voter(self, websocket: WebSocket, voter_code: str):
        await websocket.accept() 
        self.voter_connections[voter_code] = websocket
        logger.info(f"Votante {voter_code} conectado. Total votantes: {len(self.voter_connections)}")
        
        # Notificar a admins que hay nuevo votante conectado
        await self.broadcast_to_admins({
            "type": "voter_connected",
            "data": {"code": voter_code, "total_voters": len(self.voter_connections)}
        })
    
    def disconnect_admin(self, websocket: WebSocket):
        if websocket in self.admin_connections:
            self.admin_connections.remove(websocket)
        logger.info(f"Admin desconectado. Total: {len(self.admin_connections)}")
    
    def disconnect_voter(self, voter_code: str):
        if voter_code in self.voter_connections:
            del self.voter_connections[voter_code]
        logger.info(f"Votante {voter_code} desconectado. Total: {len(self.voter_connections)}")
    
    async def broadcast_to_admins(self, message: dict):
        """Enviar mensaje a todos los administradores"""
        disconnected = []
        for connection in self.admin_connections:
            try:
                await connection.send_text(json.dumps(message))
            except:
                disconnected.append(connection)
        
        # Limpiar conexiones muertas
        for conn in disconnected:
            self.disconnect_admin(conn)
    
    async def broadcast_to_voters(self, message: dict):
        """Enviar mensaje a todos los votantes"""
        disconnected = []
        for code, connection in self.voter_connections.items():
            try:
                await connection.send_text(json.dumps(message))
            except:
                disconnected.append(code)
        
        # Limpiar conexiones muertas
        for code in disconnected:
            self.disconnect_voter(code)
    
    async def send_to_voter(self, voter_code: str, message: dict):
        """Enviar mensaje a votante específico"""
        if voter_code in self.voter_connections:
            try:
                await self.voter_connections[voter_code].send_text(json.dumps(message))
            except:
                self.disconnect_voter(voter_code)

manager = ConnectionManager()

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
            
        yield
        
    except Exception as e:
        logger.error(f"❌ Error durante el startup: {e}")
        raise
    
    # Shutdown
    logger.info("🔄 Cerrando aplicación de votación...")
    try:
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
            "web-production-d4d81.up.railway.app",
            "localhost",
            "127.0.0.1"
        ]
    )

# Compresión GZIP para reducir ancho de banda
app.add_middleware(
    GZipMiddleware,
    minimum_size=1024,
    compresslevel=6  # Balanceado entre CPU y compresión
)

# CORS optimizado
if os.getenv("RAILWAY_ENVIRONMENT"):
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["https://web-production-d4d81.up.railway.app"],
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

# ================================
# WEBSOCKET ENDPOINTS
# ================================

@app.websocket("/ws/admin")
async def websocket_admin(websocket: WebSocket):
    await manager.connect_admin(websocket)
    try:
        while True:
            data = await websocket.receive_text()
            # Los admins pueden enviar comandos especiales
            try:
                message = json.loads(data)
                if message.get("type") == "ping":
                    await websocket.send_text(json.dumps({"type": "pong"}))
            except:
                pass
    except WebSocketDisconnect:
        manager.disconnect_admin(websocket)

@app.websocket("/ws/voter/{voter_code}")
async def websocket_voter(websocket: WebSocket, voter_code: str):
    await manager.connect_voter(websocket, voter_code)
    try:
        while True:
            data = await websocket.receive_text()
            # Los votantes pueden enviar heartbeat
            try:
                message = json.loads(data)
                if message.get("type") == "ping":
                    await websocket.send_text(json.dumps({"type": "pong"}))
            except:
                pass
    except WebSocketDisconnect:
        manager.disconnect_voter(voter_code)

# ================================
# NUEVOS ENDPOINTS ÚTILES
# ================================

@app.get("/api")
async def api_status():
    """Status de la API"""
    return {
        "status": "API funcionando correctamente",
        "version": "2.0.0",
        "optimized_for": "400+ concurrent users"
    }

@app.get("/api/admin/active-sessions", dependencies=[Depends(admin_required)])
async def get_active_sessions():
    """Ver quién está conectado en tiempo real"""
    return {
        "admin_connections": len(manager.admin_connections),
        "voter_connections": list(manager.voter_connections.keys()),
        "total_voters": len(manager.voter_connections)
    }

@app.post("/api/notifications/broadcast", dependencies=[Depends(admin_required)])
async def broadcast_notification(notification: dict):
    """Enviar mensaje a todos los usuarios conectados"""
    message = {
        "type": "notification",
        "data": notification,
        "timestamp": time.time()
    }
    
    # Enviar a todos
    await manager.broadcast_to_admins(message)
    await manager.broadcast_to_voters(message)
    
    return {"status": "sent", "targets": {
        "admins": len(manager.admin_connections),
        "voters": len(manager.voter_connections)
    }}

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
    "Cache-Control": f"public, max-age=3600",
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
        "limit_concurrency": 400,
        "timeout_keep_alive": 30,
        "timeout_graceful_shutdown": 30,
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