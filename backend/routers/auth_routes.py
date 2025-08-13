from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import OAuth2PasswordRequestForm
from pydantic import BaseModel
from datetime import datetime
from psycopg2 import IntegrityError
from ..database import get_db, execute_query, close_db
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
        execute_query(
            conn,
            "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
            (payload.username, get_password_hash(payload.password), payload.role),
            commit=True
        )
    except IntegrityError:
        raise HTTPException(status_code=400, detail="Usuario ya existe")
    finally:
        close_db(conn)

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
    
    # 1. Validar participante
    participant = execute_query(
        conn,
        "SELECT code, name, is_power, login_time FROM participants WHERE code = ?",
        (data.code,),
        fetchone=True
    )
    if not participant:
        close_db(conn)
        raise HTTPException(status_code=404, detail="Código no encontrado")

    # 2. Actualizar datos (primera vez o no)
    login_timestamp = datetime.now().isoformat()
    is_first_time = participant["login_time"] is None

    if is_first_time:
        # FIX: usar TRUE en lugar de 1 para present
        execute_query(
            conn,
            """UPDATE participants 
                SET present = 1, is_power = ?, login_time = ? 
                WHERE code = ?""",
            (data.is_power, login_timestamp, data.code),
            commit=True
        )
    else:
        # FIX: usar TRUE en lugar de 1 para present
        execute_query(
            conn,
            "UPDATE participants SET present = 1, is_power = ? WHERE code = ?",
            (data.is_power, data.code),
            commit=True
        )

    # 3. Obtener datos actualizados
    updated_participant = execute_query(
        conn,
        "SELECT code, name, is_power FROM participants WHERE code = ?",
        (data.code,),
        fetchone=True
    )
    close_db(conn)

    # Generar token (sin cambios)
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
