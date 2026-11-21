import json
from datetime import datetime

def export_signals(signals):
    data = {
        "signals": signals,
        "updated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "engine_version": "2.0.0-PRO"
    }
    with open("signals_data.json", "w") as f:
        json.dump(data, f, indent=2)

if __name__ == "__main__":
    export_signals([{"match": "River Plate vs Boca Juniors", "confidence": "85%"}])
