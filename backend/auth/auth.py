import os
from datetime import datetime, timedelta
from typing import Optional, Dict, Any
from jose import jwt, JWTError
from passlib.context import CryptContext
from dotenv import load_dotenv
from fastapi import HTTPException, Depends
from fastapi.security import OAuth2PasswordBearer
from ..database import get_db, execute_query

load_dotenv()

SECRET_KEY = os.getenv("SECRET_KEY", "dev_secret_change_in_prod")
ALGORITHM = os.getenv("ALGORITHM", "HS256")
ACCESS_TOKEN_EXPIRE_MINUTES = int(os.getenv("ACCESS_TOKEN_EXPIRE_MINUTES", 120))

pwd_context = CryptContext(schemes=["pbkdf2_sha256"], deprecated="auto")
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/auth/login/admin")

# ----------------------
# Password helpers
# ----------------------

def get_password_hash(password: str) -> str:
    return pwd_context.hash(password)

def verify_password(plain_password: str, hashed_password: str) -> bool:
    return pwd_context.verify(plain_password, hashed_password)

# ----------------------
# Token helpers
# ----------------------

def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    to_encode = data.copy()
    expire = datetime.utcnow() + (expires_delta or timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES))
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)

def verify_token(token: str) -> Dict[str, Any]:
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        return payload
    except JWTError:
        raise HTTPException(status_code=401, detail="Token inválido o expirado")

# ----------------------
# DB user helpers (adaptadas para PostgreSQL/SQLite)
# ----------------------

def get_user_by_username(username: str) -> Optional[dict]:
    conn = get_db()
    try:
        query = "SELECT username, password_hash, role FROM users WHERE username = ?"
        row = execute_query(conn, query, (username,), fetchone=True)
        return dict(row) if row else None
    finally:
        conn.close()

def create_default_admin_from_env():
    """
    Crea un admin desde variables de entorno si no existe.
    """
    admin_user = os.getenv("ADMIN_USER")
    admin_pass = os.getenv("ADMIN_PASS")
    if not admin_user or not admin_pass:
        return

    conn = get_db()
    # Verificar si el usuario ya existe
    query_check = "SELECT username FROM users WHERE username = ?"
    existing_user = execute_query(conn, query_check, (admin_user,), fetchone=True)
    
    if not existing_user:
        hashed = get_password_hash(admin_pass)
        query_insert = "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)"
        execute_query(conn, query_insert, (admin_user, hashed, "admin"), commit=True)
    conn.close()

# ----------------------
# Dependencies (roles)
# ----------------------

def get_current_user(token: str = Depends(oauth2_scheme)) -> dict:
    payload = verify_token(token)
    return payload

def admin_required(current_user: dict = Depends(get_current_user)) -> dict:
    if current_user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Solo administradores")
    return current_user

def voter_required(current_user: dict = Depends(get_current_user)) -> dict:
    if current_user.get("role") not in ("voter", "votante"):
        raise HTTPException(status_code=403, detail="Solo votantes")
    return current_user

def admin_or_voter_required(current_user: dict = Depends(get_current_user)) -> dict:
    if current_user.get("role") not in ("admin", "voter", "votante"):
        raise HTTPException(status_code=403, detail="Acceso no autorizado")
    return current_user