import logging
from fastapi import APIRouter, Depends, HTTPException
from ..database import get_db, execute_query, close_db
from ..auth.auth import admin_required

router = APIRouter(prefix="/admin", tags=["Admin"])
logger = logging.getLogger(__name__)

@router.delete("/delete-code/{code}", dependencies=[Depends(admin_required)])
def delete_participant_code(code: str):
    """
    Eliminar registro de asistencia de un código específico.
    Solo elimina el registro de presente, no de la base de participantes.
    """
    conn = get_db()
    try:
        # Verificar que el participante existe
        participant = execute_query(
            conn,
            "SELECT code, name, present FROM participants WHERE code = ?",
            (code,),
            fetchone=True
        )
        
        if not participant:
            raise HTTPException(status_code=404, detail="Código no encontrado en el sistema")
        
        if not participant["present"]:
            raise HTTPException(status_code=400, detail="Este código no tiene registro de asistencia")
        
        # Eliminar votos del participante
        execute_query(
            conn,
            "DELETE FROM votes WHERE participant_code = ?",
            (code,),
            commit=True
        )
        
        # Marcar como no presente y resetear has_voted
        execute_query(
            conn,
            "UPDATE participants SET present = 0, has_voted = 0, is_power = NULL WHERE code = ?",
            (code,),
            commit=True
        )
        
        return {
            "status": "codigo eliminado",
            "code": code,
            "name": participant["name"]
        }
        
    except Exception as e:
        logger.error(f"Error eliminando código {code}: {e}")
        raise HTTPException(status_code=500, detail=f"Error interno: {str(e)}")
    finally:
        close_db(conn)