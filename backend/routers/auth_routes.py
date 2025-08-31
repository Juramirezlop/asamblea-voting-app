import logging
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
logger = logging.getLogger(__name__)

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

@router.get("/check-database")
def check_database_status():
    """Verificar si hay participantes en la base de datos"""
    conn = get_db()
    try:
        result = execute_query(
            conn,
            "SELECT COUNT(*) as count FROM participants",
            fetchone=True
        )
        return {"has_participants": result["count"] > 0, "count": result["count"]}
    finally:
        close_db(conn)

# ---------- Voter login (code only) ----------
@router.post("/login/voter")
def login_voter(data: VoterLoginRequest):
    conn = get_db()
    
    # Verificar que haya participantes en la base
    total_participants = execute_query(
        conn,
        "SELECT COUNT(*) as count FROM participants",
        fetchone=True
    )

    if total_participants["count"] == 0:
        raise HTTPException(status_code=400, detail="No hay participantes registrados en el sistema")

    try:
        # 1. Validar que el participante existe Y ya tiene asistencia
        participant = execute_query(
            conn,
            "SELECT code, name, is_power, present FROM participants WHERE code = ?",
            (data.code,),
            fetchone=True
        )
        if not participant:
            raise HTTPException(status_code=404, detail="Código no encontrado")
        
        if participant.get("present") != 1:
            raise HTTPException(status_code=403, detail="Debe registrar su asistencia primero")

        # 2. Generar token sin modificar datos (los datos ya están fijos desde el registro)
        token = create_access_token({"sub": data.code, "role": "votante", "code": data.code})
        
        return {
            "access_token": token, 
            "token_type": "bearer",
            "name": participant.get("name", ""),
            "code": participant.get("code", ""),
            "is_power": participant.get("is_power", False),
            "coefficient": participant.get("coefficient", 1.00)
        }
    
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error en login_voter: {e}")
        raise HTTPException(status_code=500, detail=f"Error interno: {str(e)}")
    finally:
        close_db(conn)

# ---------- Nuevas dependencias de login ----------
@router.post("/register-attendance")
async def register_attendance(data: VoterLoginRequest):
    conn = get_db()
    
    # Verificar que haya participantes en la base
    total_participants = execute_query(
        conn,
        "SELECT COUNT(*) as count FROM participants",
        fetchone=True
    )

    if total_participants["count"] == 0:
        raise HTTPException(status_code=400, detail="No hay participantes registrados en el sistema. Debe cargar la base de datos primero.")

    try:
        # 1. Validar que el participante existe
        participant = execute_query(
            conn,
            "SELECT code, name, present, is_power FROM participants WHERE code = ?",
            (data.code,),
            fetchone=True
        )
        if not participant:
            raise HTTPException(status_code=404, detail="Código no encontrado")

        # 2. Verificar si ya está registrado
        if participant.get("present") == 1:
            raise HTTPException(status_code=400, detail="Ya tiene asistencia registrada")

        # 3. Registrar asistencia con datos fijos (no modificables después)
        login_timestamp = datetime.now().isoformat()
        execute_query(
            conn,
            """UPDATE participants 
                SET present = 1, is_power = ?, login_time = ? 
                WHERE code = ?""",
            (data.is_power, login_timestamp, data.code),
            commit=True
        )

        # WEBSOCKET: Notificar nueva asistencia registrada
        from ..main import manager
        await manager.broadcast_to_admins({
            "type": "attendance_registered",
            "data": {
                "code": data.code,
                "name": participant.get("name", ""),
                "is_power": data.is_power,
                "timestamp": login_timestamp
            }
        })

        # 4. Retornar datos de confirmación
        return {
            "code": data.code,
            "name": participant.get("name", "Sin nombre"),
            "is_power": data.is_power,
            "message": "Asistencia registrada correctamente"
        }
    
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error en register_attendance: {e}")
        raise HTTPException(status_code=500, detail=f"Error interno: {str(e)}")
    finally:
        close_db(conn)