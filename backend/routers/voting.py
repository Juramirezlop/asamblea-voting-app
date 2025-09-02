import logging
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import List
from ..database import get_db, execute_query, close_db
from ..auth.auth import admin_required, voter_required, admin_or_voter_required
from datetime import datetime, timedelta

router = APIRouter(prefix="/voting", tags=["Voting"])
logger = logging.getLogger(__name__)

# --- Schemas ---
class QuestionCreate(BaseModel):
    text: str
    type: str  # 'yesno' o 'multiple'
    options: List[str] | None = None
    allow_multiple: bool = False
    max_selections: int = 1
    time_limit_minutes: int | None = None  # NUEVO: tiempo límite en minutos

class VoteIn(BaseModel):
    question_id: int
    answer: str | List[str]

class ExtendTimeRequest(BaseModel):
    extra_minutes: int

# --- Crear pregunta (admin) ---
@router.post("/questions", dependencies=[Depends(admin_required)])
async def crear_pregunta(payload: QuestionCreate):
    typ = payload.type.lower()
    if typ not in ("yesno", "multiple"):
        raise HTTPException(status_code=400, detail="Tipo inválido (yesno|multiple)")

    allow_multiple = payload.allow_multiple if typ == "multiple" else False
    max_selections = payload.max_selections if allow_multiple else 1
    
    if allow_multiple and max_selections < 1:
        raise HTTPException(status_code=400, detail="max_selections debe ser mayor a 0")
    
    if typ == "multiple" and payload.options and allow_multiple:
        if max_selections > len(payload.options):
            raise HTTPException(status_code=400, detail="max_selections no puede ser mayor al número de opciones")

    # CALCULAR tiempo de expiración si hay límite
    expires_at = None
    time_limit = None
    if hasattr(payload, 'time_limit_minutes') and payload.time_limit_minutes and payload.time_limit_minutes > 0:
        time_limit = payload.time_limit_minutes
        expires_at = (datetime.utcnow() + timedelta(minutes=time_limit)).isoformat()
    conn = get_db()
    try:
        # MODIFICAR query para incluir campos de cronómetro
        question = execute_query(
            conn,
            """INSERT INTO questions (text, type, active, allow_multiple, max_selections, time_limit_minutes, expires_at) 
            VALUES (?, ?, 1, ?, ?, ?, ?) RETURNING id""",
            (payload.text, typ, int(allow_multiple), max_selections, time_limit, expires_at),
            fetchone=True
        )
        qid = question["id"]

        # Insertar opciones (sin cambios)
        if typ == "yesno":
            execute_query(conn, "INSERT INTO options (question_id, option_text) VALUES (?, ?)", (qid, "Sí"), commit=True)
            execute_query(conn, "INSERT INTO options (question_id, option_text) VALUES (?, ?)", (qid, "No"), commit=True)
        else:
            if not payload.options or len(payload.options) < 2:
                raise HTTPException(status_code=400, detail="Las preguntas 'multiple' requieren al menos 2 opciones")
            for opt in payload.options:
                execute_query(conn, "INSERT INTO options (question_id, option_text) VALUES (?, ?)", (qid, opt), commit=True)
        
        # WEBSOCKET: Notificar nueva votación
        from ..main import manager
        await manager.broadcast_to_voters({
            "type": "new_question",
            "data": {"question_id": qid, "text": payload.text, "type": typ}
        })
        await manager.broadcast_to_admins({
            "type": "question_created", 
            "data": {"question_id": qid, "text": payload.text}
        })
        
        return {
            "status": "ok", 
            "id": qid,
            "expires_at": expires_at,
            "time_limit_minutes": payload.time_limit_minutes
        }
    finally:
        close_db(conn)

# AGREGAR endpoint para verificar votaciones expiradas
@router.post("/questions/check-expired", dependencies=[Depends(admin_required)])
async def check_expired_questions():
    """Verificar y cerrar automáticamente votaciones que expiraron"""
    conn = get_db()
    try:
        current_time = datetime.utcnow().isoformat()
        
        # Encontrar votaciones expiradas
        expired_questions = execute_query(
            conn,
            """SELECT id, text FROM questions 
               WHERE expires_at IS NOT NULL 
               AND expires_at <= ? 
               AND closed = 0 
               AND active = 1""",
            (current_time,),
            fetchall=True
        )
        
        expired_count = 0
        for question in expired_questions:
            # Cerrar la votación
            execute_query(
                conn,
                "UPDATE questions SET closed = 1 WHERE id = ?",
                (question["id"],),
                commit=True
            )
            expired_count += 1
            logger.info(f"Votación {question['id']} cerrada automáticamente por expiración")
        
        # WEBSOCKET: Notificar votaciones cerradas por tiempo
        if expired_count > 0:
            from ..main import manager
            for question in expired_questions:
                await manager.broadcast_to_voters({
                    "type": "question_expired",
                    "data": {"question_id": question["id"], "text": question["text"]}
                })
            await manager.broadcast_to_admins({
                "type": "questions_expired",
                "data": {"count": expired_count, "questions": [dict(q) for q in expired_questions]}
            })
        
        return {
            "status": "ok",
            "expired_questions": expired_count,
            "expired_details": [dict(q) for q in expired_questions]
        }
        
    except Exception as e:
        logger.error(f"Error verificando votaciones expiradas: {e}")
        raise HTTPException(status_code=500, detail=f"Error interno: {str(e)}")
    finally:
        close_db(conn)

@router.put("/questions/{question_id}/extend-time", dependencies=[Depends(admin_required)])
async def extend_question_time(question_id: int, request: ExtendTimeRequest):
    """Extender el tiempo de una votación activa"""
    extra_minutes = request.extra_minutes
    if extra_minutes <= 0 or extra_minutes > 120:  # Máximo 2 horas extra
        raise HTTPException(status_code=400, detail="Los minutos extra deben estar entre 1 y 120")
    
    conn = get_db()
    try:
        # Verificar que la pregunta existe y está activa
        question = execute_query(
            conn,
            "SELECT id, text, expires_at, closed, time_limit_minutes FROM questions WHERE id = ? AND active = 1",
            (question_id,),
            fetchone=True
        )
        
        if not question:
            raise HTTPException(status_code=404, detail="Pregunta no encontrada o no activa")
        
        if not question["expires_at"]:
            raise HTTPException(status_code=400, detail="Esta votación no tiene límite de tiempo")
        
        if question["closed"]:
            execute_query(
                conn,
                "UPDATE questions SET closed = 0 WHERE id = ?",
                (question_id,),
                commit=True
            )

        # Calcular nueva hora de expiración
        current_expires = datetime.fromisoformat(question["expires_at"])
        new_expires = current_expires + timedelta(minutes=extra_minutes)
        new_expires_iso = new_expires.isoformat()
        
        # Actualizar tiempo límite total y nueva expiración
        new_total_minutes = (question["time_limit_minutes"] or 0) + extra_minutes
        
        execute_query(
            conn,
            "UPDATE questions SET expires_at = ?, time_limit_minutes = ? WHERE id = ?",
            (new_expires_iso, new_total_minutes, question_id),
            commit=True
        )
        
        # WEBSOCKET: Notificar extensión de tiempo
        from ..main import manager
        await manager.broadcast_to_voters({
            "type": "time_extended",
            "data": {
                "question_id": question_id,
                "text": question["text"],
                "extra_minutes": extra_minutes,
                "new_expires_at": new_expires_iso,
                "message": f"Se extendió el tiempo de votación por {extra_minutes} minutos adicionales"
            }
        })
        
        await manager.broadcast_to_admins({
            "type": "time_extended",
            "data": {
                "question_id": question_id,
                "extra_minutes": extra_minutes,
                "new_total_minutes": new_total_minutes
            }
        })
        
        return {
            "status": "tiempo extendido",
            "question_id": question_id,
            "extra_minutes": extra_minutes,
            "new_expires_at": new_expires_iso,
            "total_minutes": new_total_minutes
        }
        
    except Exception as e:
        logger.error(f"Error extendiendo tiempo de pregunta {question_id}: {e}")
        raise HTTPException(status_code=500, detail=f"Error interno: {str(e)}")
    finally:
        close_db(conn)

# --- Obtener preguntas activas (votante) ---
@router.get("/questions/active", dependencies=[Depends(admin_or_voter_required)])
def preguntas_activas():
    conn = get_db()
    try:
        current_time = datetime.utcnow().isoformat()
        
        # Consulta mejorada que incluye las opciones
        qs = execute_query(
            conn,
            """
            SELECT DISTINCT
                q.id, q.text, q.type, q.closed, q.allow_multiple, q.max_selections, 
                q.time_limit_minutes, q.expires_at
            FROM questions q 
            WHERE q.active = 1
            ORDER BY q.id DESC
            """,
            fetchall=True
        )
        
        out = []
        for q in qs:
            # Verificar si expiró
            is_expired = False
            time_remaining = None
            
            if q["expires_at"] and q["closed"] == 0:
                expires_at = datetime.fromisoformat(q["expires_at"])
                current_dt = datetime.fromisoformat(current_time)
                
                if current_dt >= expires_at:
                    is_expired = True
                    # Auto-cerrar si expiró
                    execute_query(
                        conn,
                        "UPDATE questions SET closed = 1 WHERE id = ?",
                        (q["id"],),
                        commit=True
                    )
                else:
                    time_remaining = int((expires_at - current_dt).total_seconds())
            
            # SIEMPRE obtener opciones
            options = execute_query(
                conn,
                "SELECT option_text as text FROM options WHERE question_id = ? ORDER BY id",
                (q["id"],),
                fetchall=True
            )
            
            # Crear objeto de pregunta con TODAS las opciones
            question_data = {
                "id": q["id"],
                "text": q["text"],
                "type": q["type"],
                "closed": bool(q["closed"]) or is_expired,
                "allow_multiple": bool(q["allow_multiple"]),
                "max_selections": q["max_selections"],
                "time_limit_minutes": q["time_limit_minutes"],
                "expires_at": q["expires_at"],
                "time_remaining_seconds": time_remaining,
                "is_expired": is_expired,
                "options": [{"text": o["text"]} for o in options] if options else []
            }
            
            out.append(question_data)
            
        return out
    finally:
        close_db(conn)

# --- Votar (votante) ---
@router.post("/vote", dependencies=[Depends(voter_required)])
async def votar(vote: VoteIn, user=Depends(voter_required)):
    participant_code = user.get("code") or user.get("sub")
    if not participant_code:
        raise HTTPException(status_code=400, detail="Código de votante no encontrado en token")
    
    conn = get_db()
    try:
        q = execute_query(
            conn,
            "SELECT * FROM questions WHERE id = ? AND active = 1 AND closed = 0",
            (vote.question_id,),
            fetchone=True
        )
        if not q:
            raise HTTPException(status_code=404, detail="Pregunta no encontrada, no activa o cerrada")

        # Verificar doble voto
        existing = execute_query(
            conn,
            "SELECT * FROM votes WHERE participant_code = ? AND question_id = ?",
            (participant_code, vote.question_id),
            fetchone=True
        )
        if existing:
            raise HTTPException(status_code=400, detail="Ya votó en esta pregunta")

        # Normalizar respuesta (siempre convertir a lista)
        if isinstance(vote.answer, str):
            answers = [vote.answer]
        else:
            answers = vote.answer

        # Validar selección múltiple
        if q["allow_multiple"]:
            if len(answers) > q["max_selections"]:
                raise HTTPException(status_code=400, detail=f"No puede seleccionar más de {q['max_selections']} opciones")
        else:
            if len(answers) > 1:
                raise HTTPException(status_code=400, detail="Esta pregunta solo permite una selección")

        # Validar que todas las opciones existan
        for answer in answers:
            opt = execute_query(
                conn,
                "SELECT * FROM options WHERE question_id = ? AND option_text = ?",
                (vote.question_id, answer),
                fetchone=True
            )
            if not opt:
                raise HTTPException(status_code=400, detail=f"Opción inválida: {answer}")

        # Insertar UN SOLO voto con respuestas separadas por comas
        timestamp = datetime.utcnow().isoformat()
        answer_string = ", ".join(answers)  # "Ana López, Diana Torres"
        execute_query(
            conn,
            "INSERT INTO votes (participant_code, question_id, answer, timestamp) VALUES (?, ?, ?, ?)",
            (participant_code, vote.question_id, answer_string, timestamp),
            commit=True
        )

        # Actualizar has_voted si votó en todas las preguntas activas
        active_qs = execute_query(
            conn,
            "SELECT id FROM questions WHERE active = 1",
            fetchall=True
        )
        active_ids = [r["id"] for r in active_qs]
        if active_ids:
            # Contar preguntas en las que ya votó
            placeholders = ",".join(["?"] * len(active_ids))
            voted_questions = execute_query(
                conn,
                f"SELECT DISTINCT question_id FROM votes WHERE participant_code = ? AND question_id IN ({placeholders})",
                tuple([participant_code] + active_ids),
                fetchall=True
            )
            
            if len(voted_questions) == len(active_ids):
                execute_query(
                    conn,
                    "UPDATE participants SET has_voted = 1 WHERE code = ?",
                    (participant_code,),
                    commit=True
                )

        # WEBSOCKET: Notificar voto registrado
        from ..main import manager
        await manager.broadcast_to_admins({
            "type": "vote_registered",
            "data": {
                "participant_code": participant_code, 
                "question_id": vote.question_id,
                "answer": answer_string,
                "timestamp": timestamp
            }
        })
        
        # Notificar al votante específico
        await manager.send_to_voter(participant_code, {
            "type": "vote_confirmed",
            "data": {"question_id": vote.question_id, "answers": answers}
        })

        return {"status": "voto registrado", "answers": answers}
    finally:
        close_db(conn)

# --- Votos individuales por persona ---
@router.get("/my-votes", dependencies=[Depends(voter_required)])
def mis_votos(user=Depends(voter_required)):
    participant_code = user.get("code") or user.get("sub")
    conn = get_db()
    try:
        votes = execute_query(
            conn,
            "SELECT question_id, answer FROM votes WHERE participant_code = ?", 
            (participant_code,),
            fetchall=True
        )
        return [{"question_id": vote["question_id"], "answer": vote["answer"]} for vote in votes]
    finally:
        close_db(conn)

# --- Pausar encuestas creadas ---
@router.put("/questions/{question_id}/toggle", dependencies=[Depends(admin_required)])
async def toggle_question_status(question_id: int):
    conn = get_db()
    try:
        # Obtener estado actual
        current_status = execute_query(
            conn,
            "SELECT closed, text FROM questions WHERE id = ?",
            (question_id,),
            fetchone=True
        )
        
        if not current_status:
            raise HTTPException(status_code=404, detail="Pregunta no encontrada")
        
        # Cambiar estado
        execute_query(
            conn,
            "UPDATE questions SET closed = 1 - closed WHERE id = ?",
            (question_id,),
            commit=True
        )
        
        # Obtener nuevo estado
        status = execute_query(
            conn,
            "SELECT closed FROM questions WHERE id = ?",
            (question_id,),
            fetchone=True
        )
        
        new_closed = bool(status["closed"]) if status else False
        
        # WEBSOCKET: Notificar cambio de estado
        from ..main import manager
        await manager.broadcast_to_voters({
            "type": "question_status_changed",
            "data": {
                "question_id": question_id,
                "closed": new_closed,
                "text": current_status["text"]
            }
        })
        await manager.broadcast_to_admins({
            "type": "question_toggled",
            "data": {"question_id": question_id, "closed": new_closed}
        })
        
        return {"closed": new_closed}
    finally:
        close_db(conn)

# --- Borrar encuestas ---
@router.delete("/questions/{question_id}", dependencies=[Depends(admin_required)])
async def delete_question(question_id: int):
    conn = get_db()
    try:
        # Verificar que existe
        question = execute_query(
            conn,
            "SELECT id, text FROM questions WHERE id = ?",
            (question_id,),
            fetchone=True
        )
        if not question:
            raise HTTPException(status_code=404, detail="Pregunta no encontrada")
        
        # Borrar en orden: votos → opciones → pregunta
        execute_query(conn, "DELETE FROM votes WHERE question_id = ?", (question_id,), commit=True)
        execute_query(conn, "DELETE FROM options WHERE question_id = ?", (question_id,), commit=True)
        execute_query(conn, "DELETE FROM questions WHERE id = ?", (question_id,), commit=True)
        
        # WEBSOCKET: Notificar eliminación de pregunta
        from ..main import manager
        await manager.broadcast_to_voters({
            "type": "question_deleted",
            "data": {"question_id": question_id, "text": question["text"]}
        })
        await manager.broadcast_to_admins({
            "type": "question_deleted",
            "data": {"question_id": question_id}
        })
        
        return {"status": "pregunta eliminada"}
    finally:
        close_db(conn)

# --- Editar pregunta cerrada (admin) ---
@router.put("/questions/{question_id}", dependencies=[Depends(admin_required)])
async def editar_pregunta(question_id: int, payload: dict):
    conn = get_db()
    try:
        # Verificar que la pregunta existe y está cerrada
        question = execute_query(
            conn,
            "SELECT id, type, closed, text FROM questions WHERE id = ?",
            (question_id,),
            fetchone=True
        )
        if not question:
            raise HTTPException(status_code=404, detail="Pregunta no encontrada")
        
        if not question["closed"]:
            raise HTTPException(status_code=400, detail="Solo se pueden editar preguntas cerradas")
        
        # Actualizar texto de la pregunta
        if "text" in payload:
            execute_query(
                conn,
                "UPDATE questions SET text = ? WHERE id = ?",
                (payload["text"], question_id),
                commit=True
            )
        
        # Si es pregunta múltiple y se actualizan opciones
        if question["type"] == "multiple" and "options" in payload:
            if len(payload["options"]) < 2:
                raise HTTPException(status_code=400, detail="Debe tener al menos 2 opciones")
            
            # Eliminar opciones existentes
            execute_query(conn, "DELETE FROM options WHERE question_id = ?", (question_id,), commit=True)
            
            # Insertar nuevas opciones
            for option in payload["options"]:
                execute_query(
                    conn,
                    "INSERT INTO options (question_id, option_text) VALUES (?, ?)",
                    (question_id, option),
                    commit=True
                )
        
        # Actualizar max_selections si se proporciona
        if "max_selections" in payload:
            execute_query(
                conn,
                "UPDATE questions SET max_selections = ? WHERE id = ?",
                (payload["max_selections"], question_id),
                commit=True
            )
        
        # WEBSOCKET: Notificar edición de pregunta
        from ..main import manager
        updated_text = payload.get("text", question["text"])
        await manager.broadcast_to_admins({
            "type": "question_edited",
            "data": {"question_id": question_id, "text": updated_text}
        })
        
        return {"status": "pregunta actualizada"}
    
    finally:
        close_db(conn)

# --- Resultados (admin) ---
@router.get("/results/{question_id}", dependencies=[Depends(admin_required)])
def resultados(question_id: int):
    conn = get_db()
    try:
        # Verificar pregunta
        q = execute_query(
            conn,
            "SELECT id, text, type FROM questions WHERE id = ?",
            (question_id,),
            fetchone=True
        )
        if not q:
            raise HTTPException(status_code=404, detail="Pregunta no encontrada")

        # Obtener todas las opciones (incluso las que no tengan votos)
        opts_result = execute_query(
            conn,
            "SELECT option_text FROM options WHERE question_id = ? ORDER BY option_text",
            (question_id,),
            fetchall=True
        )
        opts = [r["option_text"] for r in opts_result]

        # Obtener número de participantes únicos que votaron en esta pregunta
        unique_voters_result = execute_query(
            conn,
            "SELECT COUNT(DISTINCT participant_code) as unique_voters FROM votes WHERE question_id = ?",
            (question_id,),
            fetchone=True
        )
        unique_voters = unique_voters_result["unique_voters"] if unique_voters_result else 0

        # Obtener coeficiente total de participantes únicos
        total_weight_result = execute_query(
            conn,
            """
            SELECT COALESCE(SUM(p.coefficient), 0) as total_participant_weight 
            FROM (SELECT DISTINCT participant_code FROM votes WHERE question_id = ?) v
            JOIN participants p ON v.participant_code = p.code
            """,
            (question_id,),
            fetchone=True
        )
        total_participant_weight = float(total_weight_result["total_participant_weight"]) if total_weight_result else 0.0

        # Para cada opción, buscar si está en el string de respuestas
        rows = []
        for opt in opts:
            result = execute_query(
                conn,
                """
                SELECT 
                    COUNT(v.participant_code) as participants,
                    COALESCE(SUM(p.coefficient), 0) as weight
                FROM votes v
                JOIN participants p ON v.participant_code = p.code
                WHERE v.question_id = ? 
                AND (v.answer = ? OR v.answer LIKE ? OR v.answer LIKE ? OR v.answer LIKE ?)
                """,
                (question_id, opt, f"{opt},%", f"%, {opt},%", f"%, {opt}"),
                fetchone=True
            )
            
            if result:
                participants = int(result["participants"]) if result["participants"] else 0
                weight = float(result["weight"]) if result["weight"] else 0.0
            else:
                participants = 0
                weight = 0.0
                
            rows.append({"option": opt, "participants": participants, "weight": weight})

        # Convertir results a lista para el frontend
        results_list = []
        for r in rows:
            results_list.append({
                "answer": r["option"],
                "votes": r["participants"], 
                "percentage": round(r["weight"], 2)
            })
        
        # Ordenar de mayor a menor por porcentaje (coeficiente)
        results_list.sort(key=lambda x: x["percentage"], reverse=True)

        # Obtener total de participantes registrados en la base
        total_registered_result = execute_query(
            conn,
            "SELECT COUNT(*) as total_registered FROM participants",
            fetchone=True
        )
        total_registered = total_registered_result["total_registered"] if total_registered_result else 0

        return {
            "question_id": question_id,
            "question_text": q["text"],
            "type": q["type"],
            "total_participants": unique_voters,
            "total_registered": total_registered,
            "total_votes": sum(r["participants"] for r in rows),
            "total_participant_coefficient": round(total_participant_weight, 2),
            "results": results_list
        }
    except Exception as e:
        logger.error(f"Error en resultados: {e}")
        raise HTTPException(status_code=500, detail=f"Error interno: {str(e)}")
    finally:
        close_db(conn)

# --- Endpoint para calcular aforo/quorum ---
@router.get("/aforo")
def get_aforo(user=Depends(admin_required)):
    conn = get_db()
    try:
        # Totales generales
        totals = execute_query(
            conn,
            "SELECT COUNT(*) as total_participants, SUM(coefficient) as total_coefficient FROM participants",
            fetchone=True
        )
        total_participants = totals["total_participants"] or 0
        total_coefficient = totals["total_coefficient"] or 0.0

        # Presentes (AGREGAR coeficiente presente) - FIX: usar TRUE/FALSE
        present_data = execute_query(
            conn,
            "SELECT COUNT(*) as present_count, SUM(coefficient) as present_coefficient FROM participants WHERE present = 1",
            fetchone=True
        )
        present_count = present_data["present_count"] or 0
        present_coefficient = present_data["present_coefficient"] or 0.0

        # FIX: Cambiar 1 y 0 por TRUE y FALSE
        own_votes_result = execute_query(
            conn,
            "SELECT COUNT(*) as own_count FROM participants WHERE present = 1 AND is_power = FALSE",
            fetchone=True
        )
        own_votes = own_votes_result["own_count"] or 0

        power_votes_result = execute_query(
            conn,
            "SELECT COUNT(*) as power_count FROM participants WHERE present = 1 AND is_power = TRUE",
            fetchone=True
        )

        power_votes = power_votes_result["power_count"] or 0

        # Usar booleanos PostgreSQL
        voted_data = execute_query(
            conn,
            "SELECT COUNT(*) as voted_count FROM participants WHERE present = 1 AND has_voted = 1",
            fetchone=True
        )
        voted_count = voted_data["voted_count"] or 0

        # Cálculos de porcentajes
        participation_rate = (present_count / total_participants * 100) if total_participants > 0 else 0
        coefficient_rate = present_coefficient if total_coefficient > 0 else 0

        return {
            "total_participants": total_participants,
            "total_coefficient": total_coefficient,
            "present_count": present_count,
            "present_coefficient": present_coefficient,
            "own_votes": own_votes,
            "power_votes": power_votes,
            "voted_count": voted_count,
            "participation_rate_percent": round(participation_rate, 2),
            "coefficient_rate_percent": round(coefficient_rate, 2),
        }
    finally:
        close_db(conn)

# --- Reset DB (solo admin): borra preguntas, opciones, votos y resetea participantes ---
@router.delete("/admin/reset", dependencies=[Depends(admin_required)])
async def reset_db():
    conn = get_db()
    try:
        # Solo resetear votos y preguntas, NO config
        execute_query(conn, "DELETE FROM votes", commit=True)
        execute_query(conn, "DELETE FROM options", commit=True) 
        execute_query(conn, "DELETE FROM questions", commit=True)
        execute_query(conn, "DELETE FROM participants", commit=True)
        execute_query(conn, "DELETE FROM config", commit=True)

        # WEBSOCKET: Notificar reset completo
        from ..main import manager
        await manager.broadcast_to_voters({
            "type": "system_reset",
            "data": {"message": "La asamblea ha sido reiniciada por el administrador"}
        })
        await manager.broadcast_to_admins({
            "type": "system_reset",
            "data": {"message": "Base de datos reiniciada exitosamente"}
        })
        
        return {"status": "votaciones y asistencias reseteadas"}
    finally:
        close_db(conn)