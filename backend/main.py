# python -m uvicorn backend.main:app --reload

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from .database import init_db
from .routers import participants, voting, auth_routes
from .auth.auth import create_default_admin_from_env
from pathlib import Path
from dotenv import load_dotenv

# Ruta absoluta al .env (sube un nivel desde backend/)
env_path = Path(__file__).resolve().parent.parent / ".env"
load_dotenv(dotenv_path=env_path)

app = FastAPI(title="Asambleas API")

# CORS para desarrollo
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

# Rutas
app.include_router(auth_routes.router)
app.include_router(participants.router)
app.include_router(voting.router)

@app.get("/")
def home():
    return {"status": "ok"}