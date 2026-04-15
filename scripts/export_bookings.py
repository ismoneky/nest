#!/usr/bin/env python3
import sqlite3
import sys
import os

try:
    import openpyxl
except ImportError:
    os.system(f"{sys.executable} -m pip install openpyxl -q")
    import openpyxl

db_path = sys.argv[1]
output_path = sys.argv[2]

conn = sqlite3.connect(db_path)
cursor = conn.execute("SELECT * FROM booking ORDER BY createdAt DESC")
columns = [desc[0] for desc in cursor.description]
rows = cursor.fetchall()
conn.close()

wb = openpyxl.Workbook()
ws = wb.active
ws.title = "订单列表"
ws.append(columns)
for row in rows:
    ws.append(list(row))

wb.save(output_path)
