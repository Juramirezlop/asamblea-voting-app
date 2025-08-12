from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pathlib import Path
import os
from .database import init_db
from .routers import participants, voting, auth_routes
from .auth.auth import create_default_admin_from_env

# Cargar variables de entorno
env_path = Path(__file__).resolve().parent.parent / ".env"
load_dotenv(dotenv_path=env_path)

app = FastAPI(title="Asambleas API")

# CORS
if os.getenv("RAILWAY_ENVIRONMENT"):
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "DELETE"],
        allow_headers=["*"],
    )
else:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

# Inicializar DB y admin
init_db()
create_default_admin_from_env()

# Endpoints API (antes de montar estáticos)
app.include_router(auth_routes.router, prefix="/api")
app.include_router(participants.router, prefix="/api")
app.include_router(voting.router, prefix="/api")

@app.get("/api")
def api_status():
    return {"status": "API funcionando correctamente"}

# Ruta absoluta frontend
frontend_path = Path(__file__).resolve().parent.parent / "frontend"

# Fallback para servir AsambleaWEB.html como raíz
if frontend_path.exists():
    app.mount("/static", StaticFiles(directory=frontend_path, html=True), name="static")

    @app.get("/")
    def read_root():
        file_path = frontend_path / "AsambleaWEB.html"
        if file_path.exists():
            return FileResponse(file_path)
        return {"error": "Frontend file not found"}
else:
    print(f"⚠️ Carpeta frontend no encontrada en {frontend_path}")
