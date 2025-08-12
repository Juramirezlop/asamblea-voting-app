import sqlite3

DB_NAME = "database.db"

def get_db():
    conn = sqlite3.connect(DB_NAME)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    db = get_db()
    
    # Participantes (votantes)
    db.execute("""
        CREATE TABLE IF NOT EXISTS participants (
            code TEXT PRIMARY KEY,
            name TEXT,
            coefficient REAL,
            has_voted INTEGER DEFAULT 0,
            present INTEGER DEFAULT 0,
            is_power BOOLEAN DEFAULT 0,
            login_time TEXT
        )
    """)

    # Usuarios (admins y eventualmente otros roles)
    db.execute("""
        CREATE TABLE IF NOT EXISTS users (
            username TEXT PRIMARY KEY,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL CHECK (role IN ('admin', 'voter'))
        )
    """)

    # Preguntas de votación
    db.execute("""
        CREATE TABLE IF NOT EXISTS questions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            text TEXT NOT NULL,
            type TEXT NOT NULL CHECK (type IN ('yesno', 'multiple')),
            active INTEGER DEFAULT 1,
            closed INTEGER DEFAULT 0,
            allow_multiple INTEGER DEFAULT 0,
            max_selections INTEGER DEFAULT 1
        )
    """)

    # Opciones para preguntas tipo multiple
    db.execute("""
        CREATE TABLE IF NOT EXISTS options (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            question_id INTEGER NOT NULL,
            option_text TEXT NOT NULL,
            FOREIGN KEY (question_id) REFERENCES questions(id)
        )
    """)

    # Votos
    db.execute("""
        CREATE TABLE IF NOT EXISTS votes (
            participant_code TEXT,
            question_id INTEGER,
            answer TEXT,
            timestamp TEXT,
            PRIMARY KEY (participant_code, question_id),
            FOREIGN KEY (participant_code) REFERENCES participants(code),
            FOREIGN KEY (question_id) REFERENCES questions(id)
        )
    """)

    # Guardado de conjunto (nombre)
    db.execute("""
        CREATE TABLE IF NOT EXISTS config (
            key TEXT PRIMARY KEY,
            value TEXT
        )
    """)

    db.commit()
