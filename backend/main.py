from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from .database import init_db
from .routers import participants, voting, auth_routes
from .auth.auth import create_default_admin_from_env
from pathlib import Path
import os

# Cargar variables de entorno
env_path = Path(__file__).resolve().parent.parent / ".env"
load_dotenv(dotenv_path=env_path)

app = FastAPI(title="Asambleas API")

# CORS - más restrictivo en producción
if os.getenv("RAILWAY_ENVIRONMENT"):
    # En Railway (producción)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "DELETE"],
        allow_headers=["*"],
    )
else:
    # En desarrollo local
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

# Inicializar base y admin por defecto
init_db()
create_default_admin_from_env()

# Incluir rutas de API con prefijo
app.include_router(auth_routes.router, prefix="/api")
app.include_router(participants.router, prefix="/api")
app.include_router(voting.router, prefix="/api")

# Esto debe ir AL FINAL para que no interfiera con las rutas de API
app.mount("/", StaticFiles(directory="frontend", html=True), name="frontend")

@app.get("/api")
def api_status():
    return {"status": "API funcionando correctamente"}