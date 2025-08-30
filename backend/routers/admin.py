import logging
from fastapi import APIRouter, Depends, HTTPException
from ..database import get_db, execute_query, close_db
from ..auth.auth import admin_required
from pydantic import BaseModel
from datetime import datetime

router = APIRouter(prefix="/admin", tags=["Admin"])
logger = logging.getLogger(__name__)

class EditVoterRequest(BaseModel):
    is_power: bool

class BroadcastMessage(BaseModel):
    text: str
    type: str = "info"  # info, success, warning, error
    duration: int = 5000  # milisegundos

class EditVoteRequest(BaseModel):
    new_answer: str

@router.delete("/delete-code/{code}", dependencies=[Depends(admin_required)])
async def delete_participant_code(code: str):
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
        
        # WEBSOCKET: Notificar eliminación de código
        from ..main import manager
        await manager.broadcast_to_admins({
            "type": "participant_removed",
            "data": {"code": code, "name": participant["name"]}
        })
        
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
async def edit_voter_info(code: str, request: EditVoterRequest):
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
        
        # WEBSOCKET: Notificar cambio de votante
        from ..main import manager
        await manager.broadcast_to_admins({
            "type": "voter_edited",
            "data": {
                "code": code,
                "name": participant["name"],
                "is_power": request.is_power
            }
        })
        
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
            """SELECT v.question_id, v.answer, q.text as question_text, v.timestamp
               FROM votes v
               JOIN questions q ON v.question_id = q.id
               WHERE v.participant_code = ?
               ORDER BY v.timestamp""",
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
async def clear_voter_vote(code: str, question_id: int):
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
        
        # WEBSOCKET: Notificar voto eliminado
        from ..main import manager
        await manager.broadcast_to_admins({
            "type": "vote_cleared",
            "data": {
                "code": code,
                "question_id": question_id,
                "remaining_votes": remaining_votes["count"]
            }
        })
        
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

@router.put("/edit-vote/{code}/{question_id}", dependencies=[Depends(admin_required)])
async def edit_voter_vote(code: str, question_id: int, request: EditVoteRequest):
    """Editar el voto de un participante en una pregunta específica"""
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
        
        # Verificar que la nueva respuesta es válida para la pregunta
        option = execute_query(
            conn,
            "SELECT * FROM options WHERE question_id = ? AND option_text = ?",
            (question_id, request.new_answer),
            fetchone=True
        )
        
        if not option:
            raise HTTPException(status_code=400, detail=f"Opción '{request.new_answer}' no válida para esta pregunta")
        
        # Actualizar el voto
        execute_query(
            conn,
            "UPDATE votes SET answer = ?, timestamp = ? WHERE participant_code = ? AND question_id = ?",
            (request.new_answer, datetime.utcnow().isoformat(), code, question_id),
            commit=True
        )
        
        # WEBSOCKET: Notificar voto editado
        from ..main import manager
        await manager.broadcast_to_admins({
            "type": "vote_edited",
            "data": {
                "code": code,
                "question_id": question_id,
                "old_answer": vote["answer"],
                "new_answer": request.new_answer
            }
        })
        
        return {
            "status": "voto actualizado",
            "code": code,
            "question_id": question_id,
            "new_answer": request.new_answer
        }
        
    except Exception as e:
        logger.error(f"Error editando voto {code}/{question_id}: {e}")
        raise HTTPException(status_code=500, detail=f"Error interno: {str(e)}")
    finally:
        close_db(conn)

@router.post("/broadcast-message", dependencies=[Depends(admin_required)])
async def broadcast_message_to_voters(message: BroadcastMessage):
    """Enviar mensaje específico solo a votantes conectados"""
    from ..main import manager
    
    # Enviar solo a votantes
    await manager.broadcast_to_voters({
        "type": "admin_message",
        "data": {
            "text": message.text,
            "type": message.type,
            "duration": message.duration,
            "timestamp": datetime.utcnow().isoformat()
        }
    })
    
    # Notificar a admins que se envió el mensaje
    await manager.broadcast_to_admins({
        "type": "message_sent",
        "data": {
            "message": message.text,
            "recipients": len(manager.voter_connections)
        }
    })
    
    return {
        "status": "mensaje enviado",
        "recipients": len(manager.voter_connections),
        "message": message.text
    }

@router.get("/connected-users", dependencies=[Depends(admin_required)])
async def get_connected_users():
    """Obtener lista detallada de usuarios conectados"""
    from ..main import manager
    
    conn = get_db()
    try:
        # Obtener detalles de votantes conectados
        connected_voters = []
        for voter_code in manager.voter_connections.keys():
            participant = execute_query(
                conn,
                "SELECT code, name, coefficient, is_power FROM participants WHERE code = ? AND present = 1",
                (voter_code,),
                fetchone=True
            )
            if participant:
                connected_voters.append(dict(participant))
        
        return {
            "admin_connections": len(manager.admin_connections),
            "voter_connections": len(manager.voter_connections),
            "connected_voters": connected_voters,
            "total_connected": len(manager.admin_connections) + len(manager.voter_connections)
        }
    
    except Exception as e:
        logger.error(f"Error obteniendo usuarios conectados: {e}")
        raise HTTPException(status_code=500, detail=f"Error interno: {str(e)}")
    finally:
        close_db(conn)

@router.post("/force-disconnect/{voter_code}", dependencies=[Depends(admin_required)])
async def force_disconnect_voter(voter_code: str):
    """Forzar desconexión de un votante específico"""
    from ..main import manager
    
    if voter_code not in manager.voter_connections:
        raise HTTPException(status_code=404, detail="Votante no está conectado")
    
    # Enviar mensaje de desconexión forzada
    await manager.send_to_voter(voter_code, {
        "type": "force_disconnect",
        "data": {"message": "Ha sido desconectado por el administrador"}
    })
    
    # Desconectar
    manager.disconnect_voter(voter_code)
    
    # Notificar a admins
    await manager.broadcast_to_admins({
        "type": "voter_force_disconnected",
        "data": {"code": voter_code}
    })
    
    return {
        "status": "votante desconectado",
        "code": voter_code
    }