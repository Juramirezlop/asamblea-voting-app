import os
import sqlite3
import psycopg2
from psycopg2.extras import RealDictCursor

DB_NAME = "database.db"

def get_db():
    # Detectar si estamos en Railway (tiene DATABASE_URL)
    database_url = os.getenv("DATABASE_URL")
    
    if database_url:
        if database_url.startswith("postgresql://"):
            database_url = database_url.replace("postgresql://", "postgres://", 1)

        conn = psycopg2.connect(database_url, cursor_factory=RealDictCursor)
        return conn  # NO usar autocommit=True aquí
    else:
        # SQLite en desarrollo local
        conn = sqlite3.connect(DB_NAME)
        conn.row_factory = sqlite3.Row
        return conn
    
def execute_query(conn, query, params=(), fetchone=False, fetchall=False, commit=False):
    # Detectar si es Postgres
    is_postgres = 'psycopg2' in str(type(conn))
    
    if is_postgres:
        # Reemplazar placeholders de SQLite (?) por %s
        query = query.replace("?", "%s")
        cur = conn.cursor()
        cur.execute(query, params)
        
        result = None
        if fetchone:
            result = cur.fetchone()
        elif fetchall:
            result = cur.fetchall()
        
        if commit:
            conn.commit()
        
        cur.close()
        return result
    else:
        # SQLite
        cur = conn.cursor()
        cur.execute(query, params)
        
        result = None
        if fetchone:
            result = cur.fetchone()
        elif fetchall:
            result = cur.fetchall()
        
        if commit:
            conn.commit()
        
        return result

def init_db():
    db = get_db()
    
    # Detectar tipo de base de datos
    is_postgres = 'psycopg2' in str(type(db))
    
    if is_postgres:
        cursor = db.cursor()
        # Sintaxis PostgreSQL
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS participants (
                code TEXT PRIMARY KEY,
                name TEXT,
                coefficient REAL,
                has_voted INTEGER DEFAULT 0,
                present INTEGER DEFAULT 0,
                is_power BOOLEAN DEFAULT FALSE,
                login_time TEXT
            )
        """)

        cursor.execute("""
            CREATE TABLE IF NOT EXISTS users (
                username TEXT PRIMARY KEY,
                password_hash TEXT NOT NULL,
                role TEXT NOT NULL CHECK (role IN ('admin', 'voter'))
            )
        """)

        cursor.execute("""
            CREATE TABLE IF NOT EXISTS questions (
                id SERIAL PRIMARY KEY,
                text TEXT NOT NULL,
                type TEXT NOT NULL CHECK (type IN ('yesno', 'multiple')),
                active INTEGER DEFAULT 1,
                closed INTEGER DEFAULT 0,
                allow_multiple INTEGER DEFAULT 0,
                max_selections INTEGER DEFAULT 1
            )
        """)

        cursor.execute("""
            CREATE TABLE IF NOT EXISTS options (
                id SERIAL PRIMARY KEY,
                question_id INTEGER NOT NULL,
                option_text TEXT NOT NULL,
                FOREIGN KEY (question_id) REFERENCES questions(id)
            )
        """)

        cursor.execute("""
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

        cursor.execute("""
            CREATE TABLE IF NOT EXISTS config (
                key TEXT PRIMARY KEY,
                value TEXT
            )
        """)
        
        db.commit()
        cursor.close()
        
    else:
        cursor = db.cursor()
        # Sintaxis SQLite (tu código original)
        cursor.execute("""
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

        cursor.execute("""
            CREATE TABLE IF NOT EXISTS users (
                username TEXT PRIMARY KEY,
                password_hash TEXT NOT NULL,
                role TEXT NOT NULL CHECK (role IN ('admin', 'voter'))
            )
        """)

        cursor.execute("""
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

        cursor.execute("""
            CREATE TABLE IF NOT EXISTS options (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                question_id INTEGER NOT NULL,
                option_text TEXT NOT NULL,
                FOREIGN KEY (question_id) REFERENCES questions(id)
            )
        """)

        cursor.execute("""
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

        cursor.execute("""
            CREATE TABLE IF NOT EXISTS config (
                key TEXT PRIMARY KEY,
                value TEXT
            )
        """)
        
        db.commit()
        cursor.close()
    
    db.close()