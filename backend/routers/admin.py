import logging
from fastapi import APIRouter, Depends, HTTPException
from ..database import get_db, execute_query, close_db
from ..auth.auth import admin_required
from pydantic import BaseModel

router = APIRouter(prefix="/admin", tags=["Admin"])
logger = logging.getLogger(__name__)

class EditVoterRequest(BaseModel):
    is_power: bool

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

@router.get("/voter-info/{code}", dependencies=[Depends(admin_required)])
def get_voter_info(code: str):
    """Obtener información de un votante específico"""
    conn = get_db()
    try:
        participant = execute_query(
            conn,
            "SELECT code, name, coefficient, present, is_power, has_voted FROM participants WHERE code = ?",
            (code,),
            fetchone=True
        )
        
        if not participant:
            raise HTTPException(status_code=404, detail="Código no encontrado")
        
        return dict(participant)
        
    except Exception as e:
        logger.error(f"Error obteniendo info del votante {code}: {e}")
        raise HTTPException(status_code=500, detail=f"Error interno: {str(e)}")
    finally:
        close_db(conn)

@router.put("/edit-voter/{code}", dependencies=[Depends(admin_required)])
def edit_voter_info(code: str, request: EditVoterRequest):
    """Editar información de un votante (cambiar entre propio/poder)"""
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
            raise HTTPException(status_code=404, detail="Código no encontrado")
        
        # Actualizar tipo de participación
        execute_query(
            conn,
            "UPDATE participants SET is_power = ? WHERE code = ?",
            (request.is_power, code),
            commit=True
        )
        
        return {
            "status": "actualizado",
            "code": code,
            "name": participant["name"],
            "is_power": request.is_power
        }
        
    except Exception as e:
        logger.error(f"Error editando votante {code}: {e}")
        raise HTTPException(status_code=500, detail=f"Error interno: {str(e)}")
    finally:
        close_db(conn)

@router.get("/voter-votes/{code}", dependencies=[Depends(admin_required)])
def get_voter_votes(code: str):
    """Obtener todos los votos de un participante"""
    conn = get_db()
    try:
        votes = execute_query(
            conn,
            "SELECT question_id, answer FROM votes WHERE participant_code = ?",
            (code,),
            fetchall=True
        )
        
        return [dict(vote) for vote in votes]
        
    except Exception as e:
        logger.error(f"Error obteniendo votos del participante {code}: {e}")
        raise HTTPException(status_code=500, detail=f"Error interno: {str(e)}")
    finally:
        close_db(conn)

@router.delete("/clear-vote/{code}/{question_id}", dependencies=[Depends(admin_required)])
def clear_voter_vote(code: str, question_id: int):
    """Eliminar el voto de un participante en una pregunta específica"""
    conn = get_db()
    try:
        # Verificar que el voto existe
        vote = execute_query(
            conn,
            "SELECT * FROM votes WHERE participant_code = ? AND question_id = ?",
            (code, question_id),
            fetchone=True
        )
        
        if not vote:
            raise HTTPException(status_code=404, detail="Voto no encontrado")
        
        # Eliminar el voto
        execute_query(
            conn,
            "DELETE FROM votes WHERE participant_code = ? AND question_id = ?",
            (code, question_id),
            commit=True
        )
        
        # Actualizar has_voted si es necesario
        remaining_votes = execute_query(
            conn,
            "SELECT COUNT(*) as count FROM votes WHERE participant_code = ?",
            (code,),
            fetchone=True
        )
        
        if remaining_votes["count"] == 0:
            execute_query(
                conn,
                "UPDATE participants SET has_voted = 0 WHERE code = ?",
                (code,),
                commit=True
            )
        
        return {
            "status": "voto eliminado",
            "code": code,
            "question_id": question_id
        }
        
    except Exception as e:
        logger.error(f"Error eliminando voto {code}/{question_id}: {e}")
        raise HTTPException(status_code=500, detail=f"Error interno: {str(e)}")
    finally:
        close_db(conn)