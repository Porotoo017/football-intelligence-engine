import sqlite3
import json
from datetime import datetime
import os

DB_PATH = "data/quant_master.db"

def init_db():
    os.makedirs("data", exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS memoria_historica (
            match_id TEXT PRIMARY KEY,
            equipo_local TEXT,
            equipo_visitante TEXT,
            resultado_real TEXT,
            prediccion_emitida TEXT,
            fecha_partido DATE,
            accuracy_score REAL
        )
    """)
    conn.commit()
    conn.close()

def log_result(match_id, local, visitor, actual_score, pred):
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute("INSERT OR REPLACE INTO memoria_historica VALUES (?,?,?,?,?,?,?)",
                   (match_id, local, visitor, actual_score, pred, datetime.now().date(), 0.0))
    conn.commit()
    conn.close()

if __name__ == "__main__":
    init_db()
