from fastapi import APIRouter, Depends, UploadFile, File, HTTPException
from ..database import get_db
from ..auth.auth import admin_required
import pandas as pd
from typing import Dict
from fastapi.responses import StreamingResponse
from fpdf import FPDF
from io import BytesIO
from pydantic import BaseModel
from datetime import datetime
from openpyxl import Workbook
from openpyxl.styles import Font, Alignment

router = APIRouter(prefix="/participants", tags=["Participants"])

class ConjuntoRequest(BaseModel):
    nombre: str

# Listar participantes (solo admin)
@router.get("/", dependencies=[Depends(admin_required)])
def listar_participantes():
    db = get_db()
    cur = db.execute("SELECT * FROM participants")
    rows = [dict(r) for r in cur.fetchall()]
    return rows

# Guardar nombre del conjunto
@router.post("/conjunto/nombre", dependencies=[Depends(admin_required)])
def guardar_nombre_conjunto(request: ConjuntoRequest):
    db = get_db()
    db.execute("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)", 
                ("conjunto_nombre", request.nombre))
    db.commit()
    return {"status": "ok"}

# Obtener nombre conjunto
@router.get("/conjunto/nombre", dependencies=[Depends(admin_required)])
def obtener_nombre_conjunto():
    db = get_db()
    cur = db.execute("SELECT value FROM config WHERE key = ?", ("conjunto_nombre",))
    result = cur.fetchone()
    return {"nombre": result["value"] if result else ""}

# Carga masiva desde JSON (formato que genera tu script: { "ASM-101": {...}, ... })
@router.post("/bulk", dependencies=[Depends(admin_required)])
def agregar_participantes(data: Dict[str, dict]):
    db = get_db()
    count = 0
    for code, info in data.items():
        name = info.get("nombre") or info.get("name")
        coef = info.get("coeficiente") or info.get("coefficient") or 1.0
        ha_votado = int(bool(info.get("ha_votado", False)))
        if not code or not name:
            continue
        db.execute(
            """
            INSERT OR REPLACE INTO participants (code, name, coefficient, has_voted, present)
            VALUES (?, ?, ?, ?, ?)
            """,
            (code.upper(), name, float(coef), ha_votado, 0)
        )
        count += 1
    db.commit()
    return {"status": "ok", "cantidad": count}

# Endpoint para subir un XLSX (archivo) desde admin -> procesado con misma lógica que el script
@router.post("/upload-xlsx", dependencies=[Depends(admin_required)])
async def upload_xlsx(file: UploadFile = File(...)):
    try:
        contents = await file.read()
        from io import BytesIO
        xls = pd.read_excel(BytesIO(contents), sheet_name=None, header=None)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Error leyendo Excel: {e}")

    participantes = {}

    for sheet_name, df in xls.items():
        # Extraer el número de torre desde la fila 2 (índice 1)
        torre_number = None
        if len(df) > 1:  # Verificar que existe la fila 2
            # Buscar en las columnas de la fila 2 algún número que represente la torre
            for col in df.columns:
                cell_value = str(df.iloc[1, col]).strip().upper()
                # Buscar patrones
                import re
                torre_match = re.search(r'(\d+)', cell_value)
                if torre_match:
                    torre_number = torre_match.group(1)
                    break
        
        if not torre_number:
            # Si no encuentra torre, usar nombre de la hoja como fallback
            torre_match = re.search(r'(\d+)', sheet_name)
            torre_number = torre_match.group(1) if torre_match else "1"

        df_data = pd.read_excel(BytesIO(contents), sheet_name=sheet_name, header=2)
        df_data.columns = df_data.columns.str.strip().str.upper()
        if not all(col in df_data.columns for col in ["NO APTO", "PROPIETARIO", "COEFICIENTE"]):
            continue

        for _, row in df_data.iterrows():
            try:
                apto = str(row["NO APTO"]).strip()
                nombre = str(row["PROPIETARIO"]).strip()
                coef_str = str(row["COEFICIENTE"]).replace(",", ".").strip()
                coef = float(coef_str) if coef_str not in ("", "nan", "None") else 1.0
                
                if apto and nombre:
                    codigo = f"{torre_number}-{apto}"
                    participantes[codigo] = {
                        "nombre": nombre,
                        "coeficiente": coef,
                        "ha_votado": False
                    }
            except Exception:
                continue

    # Insertar en DB (resto igual)
    db = get_db()
    inserted = 0
    for code, info in participantes.items():
        db.execute(
            """
            INSERT OR REPLACE INTO participants (code, name, coefficient, has_voted, present)
            VALUES (?, ?, ?, ?, 0)
            """,
            (code.upper(), info["nombre"], float(info["coeficiente"]), int(info.get("ha_votado", False)))
        )
        inserted += 1
    db.commit()

    return {"status": "ok", "inserted": inserted, "sheets_processed": len(xls.keys())}

# genera PDF de asistencia
@router.post("/asistencia/pdf")
async def generar_pdf_asistencia(user=Depends(admin_required)):
    conn = get_db()
    cur = conn.cursor()

    # Obtener nombre del conjunto guardado
    cur.execute("SELECT value FROM config WHERE key = ?", ("conjunto_nombre",))
    conjunto_result = cur.fetchone()
    conjunto_name = conjunto_result["value"] if conjunto_result else "Conjunto Residencial"
    
    # Obtener participantes
    cur.execute("""
        SELECT 
            code, 
            name, 
            coefficient, 
            present,
            is_power,
            login_time
        FROM participants 
        ORDER BY code
    """)
    participantes = cur.fetchall()
    
    # Obtener estadísticas de aforo
    cur.execute("""
        SELECT 
            COUNT(*) as total_participants,
            COUNT(CASE WHEN present = 1 THEN 1 END) as present_count,
            COUNT(CASE WHEN present = 1 AND is_power = 0 THEN 1 END) as own_votes,
            COUNT(CASE WHEN present = 1 AND is_power = 1 THEN 1 END) as power_votes,
            SUM(CASE WHEN present = 1 THEN coefficient ELSE 0 END) as present_coefficient,
            SUM(coefficient) as total_coefficient
        FROM participants
    """)
    stats = dict(cur.fetchone())
    
    # Calcular porcentajes
    coefficient_percentage = stats['present_coefficient'] if stats['present_coefficient'] else 0  # Ya es porcentaje
    participation_percentage = (stats['present_count'] / stats['total_participants'] * 100) if stats['total_participants'] > 0 else 0
    quorum_met = coefficient_percentage >= 51
    
    # Obtener preguntas y resultados
    cur.execute("""
        SELECT DISTINCT q.id, q.text, q.type
        FROM questions q
        ORDER BY q.id
    """)
    preguntas = cur.fetchall()
    
    resultados_preguntas = []
    for pregunta in preguntas:
        # Obtener opciones disponibles
        cur.execute("SELECT option_text FROM options WHERE question_id = ? ORDER BY option_text", (pregunta['id'],))
        opciones = [r["option_text"] for r in cur.fetchall()]
        
        # Obtener participantes únicos que votaron
        cur.execute("SELECT COUNT(DISTINCT participant_code) as total_participants FROM votes WHERE question_id = ?", (pregunta['id'],))
        total_participants_pregunta = cur.fetchone()['total_participants']
        
        # Obtener coeficiente total de participantes únicos
        cur.execute("""
            SELECT SUM(p.coefficient) as total_participant_coefficient 
            FROM (SELECT DISTINCT participant_code FROM votes WHERE question_id = ?) v
            JOIN participants p ON v.participant_code = p.code
        """, (pregunta['id'],))
        total_participant_coefficient = float(cur.fetchone()["total_participant_coefficient"] or 0.0)
        
        # Calcular resultados por opción
        resultados = []
        for opcion in opciones:
            cur.execute("""
            SELECT 
                COUNT(v.participant_code) as votes,
                SUM(p.coefficient) as coefficient_sum
            FROM options o
            LEFT JOIN votes v ON v.question_id = o.question_id AND (
                v.answer = o.option_text OR 
                v.answer LIKE '%' || o.option_text || '%'
            )
            LEFT JOIN participants p ON v.participant_code = p.code
            WHERE o.question_id = ? AND o.option_text = ?
            """, (pregunta['id'], opcion))
            
            result = cur.fetchone()
            votes = result['votes'] or 0
            coefficient_sum = float(result['coefficient_sum'] or 0.0)
            
            resultados.append({
                'answer': opcion,
                'votes': votes,
                'percentage': coefficient_sum  # Ya es el porcentaje correcto
            })
        
        # Ordenar por porcentaje (coeficiente) descendente
        resultados.sort(key=lambda x: x['percentage'], reverse=True)
        
        resultados_preguntas.append({
            'pregunta': pregunta,
            'resultados': resultados,
            'total_participants': total_participants_pregunta,
            'total_participant_coefficient': total_participant_coefficient
        })
    
    conn.close()

    # Crear PDF
    pdf = FPDF()
    pdf.add_page()
    
    # Encabezado principal
    pdf.set_font("Arial", 'B', 18)
    pdf.cell(0, 12, f"REPORTE COMPLETO DE ASAMBLEA", ln=True, align="C")
    pdf.set_font("Arial", 'B', 14)
    pdf.cell(0, 8, f"{conjunto_name}", ln=True, align="C")
    
    pdf.set_font("Arial", size=10)
    pdf.cell(0, 6, f"Fecha: {datetime.now().strftime('%d/%m/%Y %H:%M')}", ln=True, align="C")
    pdf.ln(8)

    # SECCIÓN 1: LISTA DE ASISTENCIA DETALLADA
    pdf.set_font("Arial", 'B', 12)
    pdf.cell(0, 8, "1. LISTA DE ASISTENCIA DETALLADA", ln=True)
    pdf.ln(5)

    # Encabezados de tabla
    pdf.set_font("Arial", 'B', 8)
    pdf.cell(15, 8, "No.", border=1, align="C")
    pdf.cell(25, 8, "Apartamento", border=1, align="C")
    pdf.cell(50, 8, "Nombre", border=1, align="C") 
    pdf.cell(20, 8, "Coeficiente", border=1, align="C")
    pdf.cell(30, 8, "Fecha Ingreso", border=1, align="C")
    pdf.cell(20, 8, "Asistencia", border=1, align="C")
    pdf.cell(20, 8, "Poder", border=1, align="C", ln=True)

    # Datos de asistencia
    pdf.set_font("Arial", size=8)
    id_counter = 1
    
    for p in participantes:
        fecha_ingreso = "-"
        if p["login_time"] and p["present"]:
            try:
                dt = datetime.fromisoformat(p["login_time"])
                fecha_ingreso = dt.strftime('%d/%m %H:%M')
            except:
                fecha_ingreso = "Error"
        
        asistencia = "SÍ" if p["present"] else "NO"
        poder = "SÍ" if p["is_power"] else "NO"

        pdf.cell(15, 6, str(id_counter), border=1, align="C")
        pdf.cell(25, 6, p["code"], border=1, align="C")
        pdf.cell(50, 6, p["name"][:25], border=1)
        pdf.cell(20, 6, f"{p['coefficient']:.2f}", border=1, align="C")
        pdf.cell(30, 6, fecha_ingreso, border=1, align="C")
        pdf.cell(20, 6, asistencia, border=1, align="C")
        pdf.cell(20, 6, poder if p["present"] else "-", border=1, align="C", ln=True)

        id_counter += 1

    # SECCIÓN 2: ESTADÍSTICAS GENERALES
    pdf.add_page()
    pdf.set_font("Arial", 'B', 12)
    pdf.cell(0, 8, "2. ESTADÍSTICAS GENERALES", ln=True)
    pdf.ln(2)
    
    pdf.set_font("Arial", size=9)
    stats_data = [
        f"Total participantes registrados: {stats['total_participants']}",
        f"Participantes presentes: {stats['present_count']}",
        f"Votos por cuenta propia: {stats['own_votes']}",
        f"Votos por poder: {stats['power_votes']}",
        f"Participación por coeficiente: {coefficient_percentage:.2f}%"
    ]
    
    for stat in stats_data:
        pdf.cell(0, 6, stat, ln=True)
    pdf.ln(3)

    # SECCIÓN 3: ESTADO DEL QUÓRUM
    pdf.set_font("Arial", 'B', 12)
    pdf.cell(0, 8, "3. ESTADO DEL QUÓRUM", ln=True)
    pdf.ln(2)
    
    if quorum_met:
        pdf.set_text_color(0, 128, 0)  # Verde
        pdf.set_font("Arial", 'B', 11)
        pdf.cell(0, 8, f"QUÓRUM ALCANZADO ({coefficient_percentage:.2f}% >= 51%)", ln=True)
    else:
        pdf.set_text_color(255, 0, 0)  # Rojo
        pdf.set_font("Arial", 'B', 11)
        pdf.cell(0, 8, f"SIN QUÓRUM ({coefficient_percentage:.2f}% < 51%)", ln=True)
    
    pdf.set_text_color(0, 0, 0)  # Volver a negro
    pdf.ln(5)

    # SECCIÓN 4: RESULTADOS DE VOTACIONES
    if resultados_preguntas:
        pdf.set_font("Arial", 'B', 12)
        pdf.cell(0, 8, "4. RESULTADOS DE VOTACIONES", ln=True)
        pdf.ln(2)
        
        for i, resultado in enumerate(resultados_preguntas, 1):
            pregunta = resultado['pregunta']
            resultados = resultado['resultados']
            
            pdf.set_font("Arial", 'B', 10)
            pdf.cell(0, 7, f"Pregunta {i}: {pregunta['text'][:80]}...", ln=True)
            
            pdf.set_font("Arial", size=9)
            pdf.cell(0, 5, f"Total presentes en asamblea: {stats['present_count']}", ln=True)
            pdf.cell(0, 5, f"Participaron en esta votación: {resultado['total_participants']}", ln=True)
            pdf.cell(0, 5, f"Participación: {resultado['total_participant_coefficient']:.2f}%", ln=True)
            pdf.ln(2)
            
            if resultados:
                for res in resultados:
                    pdf.cell(0, 5, f"  - {res['answer']}: {res['votes']} votos ({res['percentage']:.2f}%)", ln=True)
            else:
                pdf.cell(0, 5, "Sin votos registrados", ln=True)
            pdf.ln(3)

    pdf_bytes = pdf.output(dest="S").encode('latin-1')
    buffer = BytesIO(pdf_bytes)
    buffer.seek(0)

    return StreamingResponse(buffer, media_type="application/pdf", headers={
        "Content-Disposition": f"attachment; filename=reporte_completo_{conjunto_name.replace(' ', '_')}.pdf"
    })

@router.post("/asistencia/xlsx")
async def generar_xlsx_asistencia(user=Depends(admin_required)):
    conn = get_db()
    cur = conn.cursor()

    # Obtener nombre del conjunto guardado
    cur.execute("SELECT value FROM config WHERE key = ?", ("conjunto_nombre",))
    conjunto_result = cur.fetchone()
    conjunto_name = conjunto_result["value"] if conjunto_result else "Conjunto Residencial"

    cur.execute("""
        SELECT 
            code, 
            name, 
            coefficient, 
            present,
            is_power,
            login_time
        FROM participants 
        ORDER BY code
    """)
    participantes = cur.fetchall()
    conn.close()

    wb = Workbook()
    ws = wb.active
    ws.title = "Asistencia"
    
    # Encabezados
    ws['A1'] = f"LISTA DE ASISTENCIA - {conjunto_name}"
    ws['A2'] = f"Fecha: {datetime.now().strftime('%d/%m/%Y %H:%M')}"
    
    headers = ["Apartamento", "Nombre", "Coeficiente", "Fecha Ingreso", "Asistencia", "Poder"]
    for col, header in enumerate(headers, 1):
        cell = ws.cell(row=4, column=col, value=header)
        cell.font = Font(bold=True)
        cell.alignment = Alignment(horizontal='center')

    # Datos
    total_presentes = 0
    coef_presentes = 0.0
    row_num = 5
    
    for p in participantes:
        fecha_ingreso = "-"
        if p["login_time"] and p["present"]:
            try:
                dt = datetime.fromisoformat(p["login_time"])
                fecha_ingreso = dt.strftime('%d/%m %H:%M')
            except:
                fecha_ingreso = "Error"
        
        asistencia = "SI" if p["present"] else "NO"
        poder = "Si" if p["is_power"] else "No"
        
        if p["present"]:
            total_presentes += 1
            coef_presentes += p["coefficient"]
        
        ws.cell(row=row_num, column=1, value=p["code"])
        ws.cell(row=row_num, column=2, value=p["name"])
        ws.cell(row=row_num, column=3, value=p["coefficient"])
        ws.cell(row=row_num, column=4, value=fecha_ingreso)
        ws.cell(row=row_num, column=5, value=asistencia)
        ws.cell(row=row_num, column=6, value=poder if p["present"] else "-")
        row_num += 1

    buffer = BytesIO()
    wb.save(buffer)
    buffer.seek(0)
    
    return StreamingResponse(buffer, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", headers={
        "Content-Disposition": f"attachment; filename=asistencia_{conjunto_name.replace(' ', '_')}.xlsx"
    })