from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import List
from ..database import get_db, execute_query, close_db
from ..auth.auth import admin_required, voter_required, admin_or_voter_required
from datetime import datetime

router = APIRouter(prefix="/voting", tags=["Voting"])

# --- Schemas ---
class QuestionCreate(BaseModel):
    text: str
    type: str  # 'yesno' o 'multiple'
    options: List[str] | None = None
    allow_multiple: bool = False
    max_selections: int = 1

class VoteIn(BaseModel):
    question_id: int
    answer: str | List[str]

# --- Crear pregunta (admin) ---
@router.post("/questions", dependencies=[Depends(admin_required)])
def crear_pregunta(payload: QuestionCreate):
    typ = payload.type.lower()
    if typ not in ("yesno", "multiple"):
        raise HTTPException(status_code=400, detail="Tipo inválido (yesno|multiple)")

    # Validaciones para selección múltiple
    allow_multiple = payload.allow_multiple if typ == "multiple" else False
    max_selections = payload.max_selections if allow_multiple else 1
    
    if allow_multiple and max_selections < 1:
        raise HTTPException(status_code=400, detail="max_selections debe ser mayor a 0")
    
    if typ == "multiple" and payload.options and allow_multiple:
        if max_selections > len(payload.options):
            raise HTTPException(status_code=400, detail="max_selections no puede ser mayor al número de opciones")

    conn = get_db()
    try:
        # Insertar pregunta y obtener el ID
        question = execute_query(
            conn,
            "INSERT INTO questions (text, type, active, allow_multiple, max_selections) VALUES (?, ?, 1, ?, ?) RETURNING id",
            (payload.text, typ, int(allow_multiple), max_selections),
            fetchone=True
        )
        qid = question["id"]

        if typ == "yesno":
            execute_query(conn, "INSERT INTO options (question_id, option_text) VALUES (?, ?)", (qid, "Sí"), commit=True)
            execute_query(conn, "INSERT INTO options (question_id, option_text) VALUES (?, ?)", (qid, "No"), commit=True)
        else:
            if not payload.options or len(payload.options) < 2:
                raise HTTPException(status_code=400, detail="Las preguntas 'multiple' requieren al menos 2 opciones")
            for opt in payload.options:
                execute_query(conn, "INSERT INTO options (question_id, option_text) VALUES (?, ?)", (qid, opt), commit=True)
        
        return {"status": "ok", "id": qid}
    finally:
        close_db(conn)

# --- Obtener preguntas activas (votante) ---
@router.get("/questions/active", dependencies=[Depends(admin_or_voter_required)])
def preguntas_activas():
    conn = get_db()
    try:
        qs = execute_query(
            conn,
            "SELECT id, text, type, closed, allow_multiple, max_selections FROM questions WHERE active = 1",
            fetchall=True
        )
        
        out = []
        for q in qs:
            options = execute_query(
                conn,
                "SELECT option_text FROM options WHERE question_id = ?",
                (q["id"],),
                fetchall=True
            )
            out.append({
                "id": q["id"],
                "text": q["text"],
                "type": q["type"],
                "closed": bool(q["closed"]),
                "allow_multiple": bool(q["allow_multiple"]),
                "max_selections": q["max_selections"],
                "options": [{"text": o["option_text"]} for o in options]
            })
        return out
    finally:
        close_db(conn)

# --- Votar (votante) ---
@router.post("/vote", dependencies=[Depends(voter_required)])
def votar(vote: VoteIn, user=Depends(voter_required)):
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
def toggle_question_status(question_id: int):
    conn = get_db()
    try:
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
        return {"closed": bool(status["closed"]) if status else False}
    finally:
        close_db(conn)

# --- Borrar encuestas ---
@router.delete("/questions/{question_id}", dependencies=[Depends(admin_required)])
def delete_question(question_id: int):
    conn = get_db()
    try:
        # Verificar que existe
        question = execute_query(
            conn,
            "SELECT id FROM questions WHERE id = ?",
            (question_id,),
            fetchone=True
        )
        if not question:
            raise HTTPException(status_code=404, detail="Pregunta no encontrada")
        
        # Borrar en orden: votos → opciones → pregunta
        execute_query(conn, "DELETE FROM votes WHERE question_id = ?", (question_id,), commit=True)
        execute_query(conn, "DELETE FROM options WHERE question_id = ?", (question_id,), commit=True)
        execute_query(conn, "DELETE FROM questions WHERE id = ?", (question_id,), commit=True)
        
        return {"status": "pregunta eliminada"}
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
        unique_voters = unique_voters_result["unique_voters"] or 0

        # Obtener coeficiente total de participantes únicos
        total_weight_result = execute_query(
            conn,
            """
            SELECT SUM(p.coefficient) as total_participant_weight 
            FROM (SELECT DISTINCT participant_code FROM votes WHERE question_id = ?) v
            JOIN participants p ON v.participant_code = p.code
            """,
            (question_id,),
            fetchone=True
        )
        total_participant_weight = float(total_weight_result["total_participant_weight"] or 0.0)

        # Para cada opción, buscar si está en el string de respuestas
        rows = []
        for opt in opts:
            result = execute_query(
                conn,
                """
                SELECT 
                    COUNT(v.participant_code) as participants,
                    SUM(p.coefficient) as weight
                FROM options o
                LEFT JOIN votes v ON v.question_id = o.question_id AND (
                    v.answer = o.option_text OR 
                    v.answer LIKE '%' || o.option_text || '%'
                )
                LEFT JOIN participants p ON v.participant_code = p.code
                WHERE o.question_id = ? AND o.option_text = ?
                """,
                (question_id, opt),
                fetchone=True
            )
            participants = result["participants"] or 0
            weight = float(result["weight"] or 0.0)
            rows.append({"option": opt, "participants": participants, "weight": weight})

        # Simplemente mostrar la suma de coeficientes como "porcentaje"
        results = {}
        total_participants = sum(r["participants"] for r in rows)
        for r in rows:
            # El "porcentaje" es simplemente la suma de coeficientes
            coefficient_sum = r["weight"]  # Suma de coeficientes
            results[r["option"]] = {
                "participants": r["participants"],
                "percent": round(coefficient_sum, 2)  # Mostrar con 1 decimal
            }

        # Convertir results dict a lista para el frontend
        results_list = []
        for option, data in results.items():
            results_list.append({
                "answer": option,
                "votes": data["participants"], 
                "percentage": data["percent"]
            })
        
        # Ordenar de mayor a menor por porcentaje (coeficiente)
        results_list.sort(key=lambda x: x["percentage"], reverse=True)

        return {
            "question_id": question_id,
            "question_text": q["text"],
            "type": q["type"],
            "total_participants": unique_voters,
            "total_votes": total_participants,
            "total_participant_coefficient": round(total_participant_weight, 2),
            "results": results_list
        }
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

        # FIX: usar TRUE para present
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
def reset_db():
    conn = get_db()
    try:
        # Borrar preguntas, opciones, votos
        execute_query(conn, "DELETE FROM votes", commit=True)
        execute_query(conn, "DELETE FROM options", commit=True) 
        execute_query(conn, "DELETE FROM questions", commit=True)
        execute_query(conn, "DELETE FROM participants", commit=True)
        # No borrar sqlite_sequence en PostgreSQL
        return {"status": "borrado realizado"}
    finally:
        close_db(conn)