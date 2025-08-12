from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import OAuth2PasswordRequestForm
from pydantic import BaseModel
from datetime import datetime
import sqlite3
from ..database import get_db
from ..auth.auth import (
    create_access_token,
    verify_password,
    get_user_by_username,
    get_password_hash,
    admin_required,
    voter_required,
)

router = APIRouter(prefix="/auth", tags=["Auth"])


# ---------- Schemas ----------
class RegisterUser(BaseModel):
    username: str
    password: str
    role: str  # 'admin' or 'voter'

class VoterLoginRequest(BaseModel):
    code: str
    is_power: bool = False

# ---------- Register endpoint (create user) ----------
@router.post("/register", status_code=status.HTTP_201_CREATED)
def register_user(payload: RegisterUser):
    if payload.role not in ("admin", "voter"):
        raise HTTPException(status_code=400, detail="Role inválido")

    conn = get_db()
    try:
        conn.execute(
            "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
            (payload.username, get_password_hash(payload.password), payload.role),
        )
        conn.commit()
    except sqlite3.IntegrityError:
        raise HTTPException(status_code=400, detail="Usuario ya existe")
    finally:
        conn.close()

    return {"msg": f"Usuario '{payload.username}' creado con rol '{payload.role}'"}

# ---------- Admin login (using form because OAuth2PasswordRequestForm expects form-data) ----------
@router.post("/login/admin")
def login_admin(form_data: OAuth2PasswordRequestForm = Depends()):
    user = get_user_by_username(form_data.username)
    if not user or not verify_password(form_data.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Credenciales inválidas")
    token = create_access_token({"sub": user["username"], "role": "admin"})
    return {"access_token": token, "token_type": "bearer"}

# ---------- Voter login (code only) ----------
@router.post("/login/voter")
def login_voter(data: VoterLoginRequest):
    conn = get_db()
    cur = conn.cursor()

    # Validar si el votante existe y obtener sus datos
    cur.execute("SELECT code, name, is_power, login_time FROM participants WHERE code = ?", (data.code,))
    participant = cur.fetchone()
    
    if not participant:
        conn.close()
        raise HTTPException(status_code=404, detail="Código no encontrado")

    login_timestamp = datetime.now().isoformat()
    is_first_time = participant["login_time"] is None
    
    if not is_first_time:
        # Ya logueado antes - actualizar presente y is_power por si viene en el request
        cur.execute("UPDATE participants SET present = 1, is_power = ? WHERE code = ?", (data.is_power, data.code))
    
    elif is_first_time:
        # Primera vez - registrar todo (tanto propietario como poder)
        cur.execute("""
            UPDATE participants 
            SET present = 1, is_power = ?, login_time = ? 
            WHERE code = ?
        """, (data.is_power, login_timestamp, data.code))
    
    conn.commit()
    
    # Obtener datos actualizados
    cur.execute("SELECT code, name, is_power FROM participants WHERE code = ?", (data.code,))
    updated_participant = cur.fetchone()
    conn.close()

    # Generar token
    token = create_access_token({"sub": data.code, "role": "votante", "code": data.code})
    
    return {
        "access_token": token, 
        "token_type": "bearer",
        "name": updated_participant["name"],
        "code": updated_participant["code"],
        "skip_power_question": not is_first_time
    }

# ---------- Test endpoints ----------
@router.get("/solo-admin", dependencies=[Depends(admin_required)])
def test_admin():
    return {"msg": "Acceso admin OK"}

@router.get("/solo-voter", dependencies=[Depends(voter_required)])
def test_voter():
    return {"msg": "Acceso votante OK"}
