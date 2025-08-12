from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import List
from ..database import get_db
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

    db = get_db()
    # Incluir nuevos campos
    cur = db.execute(
        "INSERT INTO questions (text, type, active, allow_multiple, max_selections) VALUES (?, ?, 1, ?, ?)", 
        (payload.text, typ, allow_multiple, max_selections)
    )
    qid = cur.lastrowid

    if typ == "yesno":
        db.execute("INSERT INTO options (question_id, option_text) VALUES (?, ?)", (qid, "Sí"))
        db.execute("INSERT INTO options (question_id, option_text) VALUES (?, ?)", (qid, "No"))
    else:
        if not payload.options or len(payload.options) < 2:
            raise HTTPException(status_code=400, detail="Las preguntas 'multiple' requieren al menos 2 opciones")
        for opt in payload.options:
            db.execute("INSERT INTO options (question_id, option_text) VALUES (?, ?)", (qid, opt))
    db.commit()
    return {"status": "ok", "id": qid}

# --- Obtener preguntas activas (votante) ---
@router.get("/questions/active", dependencies=[Depends(admin_or_voter_required)])
def preguntas_activas():
    db = get_db()
    qs = db.execute("SELECT id, text, type, closed, allow_multiple, max_selections FROM questions WHERE active = 1").fetchall()
    out = []
    for q in qs:
        options = db.execute("SELECT option_text FROM options WHERE question_id = ?", (q["id"],)).fetchall()
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

# --- Votar (votante) ---
@router.post("/vote", dependencies=[Depends(voter_required)])
def votar(vote: VoteIn, user=Depends(voter_required)):
    participant_code = user.get("code") or user.get("sub")
    if not participant_code:
        raise HTTPException(status_code=400, detail="Código de votante no encontrado en token")
    
    db = get_db()
    q = db.execute("SELECT * FROM questions WHERE id = ? AND active = 1 AND closed = 0", (vote.question_id,)).fetchone()
    if not q:
        raise HTTPException(status_code=404, detail="Pregunta no encontrada, no activa o cerrada")

    # Verificar doble voto
    existing = db.execute("SELECT * FROM votes WHERE participant_code = ? AND question_id = ?", (participant_code, vote.question_id)).fetchone()
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
        opt = db.execute("SELECT * FROM options WHERE question_id = ? AND option_text = ?", (vote.question_id, answer)).fetchone()
        if not opt:
            raise HTTPException(status_code=400, detail=f"Opción inválida: {answer}")

    # CAMBIO AQUÍ: Insertar UN SOLO voto con respuestas separadas por comas
    timestamp = datetime.utcnow().isoformat()
    answer_string = ", ".join(answers)  # "Ana López, Diana Torres"
    db.execute(
        "INSERT INTO votes (participant_code, question_id, answer, timestamp) VALUES (?, ?, ?, ?)",
        (participant_code, vote.question_id, answer_string, timestamp)
    )

    db.commit()

    # Actualizar has_voted si votó en todas las preguntas activas
    active_qs = db.execute("SELECT id FROM questions WHERE active = 1").fetchall()
    active_ids = [r["id"] for r in active_qs]
    if active_ids:
        # Contar preguntas en las que ya votó
        voted_questions = db.execute(
            "SELECT DISTINCT question_id FROM votes WHERE participant_code = ? AND question_id IN ({seq})".format(
                seq=",".join(["?"]*len(active_ids))
            ),
            tuple([participant_code] + active_ids)
        ).fetchall()
        
        if len(voted_questions) == len(active_ids):
            db.execute("UPDATE participants SET has_voted = 1 WHERE code = ?", (participant_code,))
            db.commit()

    return {"status": "voto registrado", "answers": answers}

# --- Votos individuales por persona ---
@router.get("/my-votes", dependencies=[Depends(voter_required)])
def mis_votos(user=Depends(voter_required)):
    participant_code = user.get("code") or user.get("sub")
    db = get_db()
    
    votes = db.execute(
        "SELECT question_id, answer FROM votes WHERE participant_code = ?", 
        (participant_code,)
    ).fetchall()
    
    return [{"question_id": vote["question_id"], "answer": vote["answer"]} for vote in votes]

# --- Pausar encuestas creadas ---
@router.put("/questions/{question_id}/toggle", dependencies=[Depends(admin_required)])
def toggle_question_status(question_id: int):
    db = get_db()
    db.execute("UPDATE questions SET closed = 1 - closed WHERE id = ?", (question_id,))
    db.commit()
    
    # Obtener nuevo estado
    status = db.execute("SELECT closed FROM questions WHERE id = ?", (question_id,)).fetchone()
    return {"closed": bool(status["closed"]) if status else False}

# --- Borrar encuestas ---
@router.delete("/questions/{question_id}", dependencies=[Depends(admin_required)])
def delete_question(question_id: int):
    db = get_db()
    
    # Verificar que existe
    question = db.execute("SELECT id FROM questions WHERE id = ?", (question_id,)).fetchone()
    if not question:
        raise HTTPException(status_code=404, detail="Pregunta no encontrada")
    
    # Borrar en orden: votos → opciones → pregunta
    db.execute("DELETE FROM votes WHERE question_id = ?", (question_id,))
    db.execute("DELETE FROM options WHERE question_id = ?", (question_id,))
    db.execute("DELETE FROM questions WHERE id = ?", (question_id,))
    db.commit()
    
    return {"status": "pregunta eliminada"}

# --- Resultados (admin) ---
@router.get("/results/{question_id}", dependencies=[Depends(admin_required)])
def resultados(question_id: int):
    db = get_db()
    cur = db.cursor()

    # Verificar pregunta
    cur.execute("SELECT id, text, type FROM questions WHERE id = ?", (question_id,))
    q = cur.fetchone()
    if not q:
        db.close()
        raise HTTPException(status_code=404, detail="Pregunta no encontrada")

    # Obtener todas las opciones (incluso las que no tengan votos)
    cur.execute("SELECT option_text FROM options WHERE question_id = ? ORDER BY option_text", (question_id,))
    opts = [r["option_text"] for r in cur.fetchall()]

    # Obtener número de participantes únicos que votaron en esta pregunta
    cur.execute("SELECT COUNT(DISTINCT participant_code) as unique_voters FROM votes WHERE question_id = ?", (question_id,))
    unique_voters = cur.fetchone()["unique_voters"] or 0

    # Obtener coeficiente total de participantes únicos
    cur.execute("""
        SELECT SUM(p.coefficient) as total_participant_weight 
        FROM (SELECT DISTINCT participant_code FROM votes WHERE question_id = ?) v
        JOIN participants p ON v.participant_code = p.code
    """, (question_id,))

    total_participant_weight = float(cur.fetchone()["total_participant_weight"] or 0.0)

    # Para cada opción, buscar si está en el string de respuestas
    rows = []
    for opt in opts:
        cur.execute("""
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
            """, (question_id, opt))
        r = cur.fetchone()
        participants = r["participants"] or 0
        weight = float(r["weight"] or 0.0)
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

    db.close()

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

# --- Endpoint para calcular aforo/quorum ---
@router.get("/aforo")
def get_aforo(user=Depends(admin_required)):
    conn = get_db()
    cur = conn.cursor()

    # Totales generales
    cur.execute("SELECT COUNT(*) as total_participants, SUM(coefficient) as total_coefficient FROM participants")
    totals = cur.fetchone()
    total_participants = totals["total_participants"] or 0
    total_coefficient = totals["total_coefficient"] or 0.0

    # Presentes (AGREGAR coeficiente presente)
    cur.execute("SELECT COUNT(*) as present_count, SUM(coefficient) as present_coefficient FROM participants WHERE present = 1")
    present_data = cur.fetchone()
    present_count = present_data["present_count"] or 0
    present_coefficient = present_data["present_coefficient"] or 0.0

    cur.execute("SELECT COUNT(*) as own_count FROM participants WHERE present = 1 AND is_power = 0")
    own_votes = cur.fetchone()["own_count"] or 0

    cur.execute("SELECT COUNT(*) as power_count FROM participants WHERE present = 1 AND is_power = 1") 
    power_votes = cur.fetchone()["power_count"] or 0

    cur.execute("SELECT COUNT(*) as voted_count FROM participants WHERE present = 1 AND has_voted = 1")
    voted_data = cur.fetchone()
    voted_count = voted_data["voted_count"] or 0

    conn.close()

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

# --- Reset DB (solo admin): borra preguntas, opciones, votos y resetea participantes ---
@router.delete("/admin/reset", dependencies=[Depends(admin_required)])
def reset_db():
    db = get_db()
    # Borrar preguntas, opciones, votos
    db.execute("DELETE FROM votes")
    db.execute("DELETE FROM options")
    db.execute("DELETE FROM questions")
    db.execute("DELETE FROM participants")
    db.execute("DELETE FROM sqlite_sequence")
    db.commit()
    return {"status": "borrado realizado"}
