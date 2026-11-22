import os
from pathlib import Path

# Tests laufen immer gegen die Test-Person, nie gegen echte Unterlagen.
os.environ["JOB_DATA_DIR"] = str(Path(__file__).parent / "fixtures" / "data")
