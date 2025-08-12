import os
from datetime import datetime, timedelta
from typing import Optional, Dict, Any
from jose import jwt, JWTError
from passlib.context import CryptContext
from dotenv import load_dotenv
from fastapi import HTTPException, Depends
from fastapi.security import OAuth2PasswordBearer
from ..database import get_db

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
# DB user helpers
# ----------------------
def get_user_by_username(username: str) -> Optional[dict]:
    conn = get_db()
    cur = conn.execute("SELECT username, password_hash, role FROM users WHERE username = ?", (username,))
    row = cur.fetchone()
    conn.close()
    return dict(row) if row else None


def create_default_admin_from_env():
    """
    If ADMIN_USER and ADMIN_PASS exist in .env and user not present, create it.
    Called from main.py (optional).
    """
    admin_user = os.getenv("ADMIN_USER")
    admin_pass = os.getenv("ADMIN_PASS")
    if not admin_user or not admin_pass:
        return

    conn = get_db()
    cur = conn.execute("SELECT username FROM users WHERE username = ?", (admin_user,))
    if not cur.fetchone():
        hashed = get_password_hash(admin_pass)
        conn.execute("INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
                    (admin_user, hashed, "admin"))
        conn.commit()
    conn.close()


# ----------------------
# Dependencies (roles)
# ----------------------
def get_current_user(token: str = Depends(oauth2_scheme)) -> dict:
    payload = verify_token(token)
    return payload  # e.g. {"sub": "admin", "role": "admin"} or {"code":"ASM-101","role":"voter"}


def admin_required(current_user: dict = Depends(get_current_user)) -> dict:
    if current_user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Solo administradores")
    return current_user


def voter_required(current_user: dict = Depends(get_current_user)) -> dict:
    # Allow role 'voter' or 'votante' depending on naming; we standardize on 'voter'
    if current_user.get("role") not in ("voter", "votante"):
        raise HTTPException(status_code=403, detail="Solo votantes")
    return current_user

def admin_or_voter_required(current_user: dict = Depends(get_current_user)) -> dict:
    # Permite acceso tanto a admins como a votantes
    if current_user.get("role") not in ("admin", "voter", "votante"):
        raise HTTPException(status_code=403, detail="Acceso no autorizado")
    return current_user