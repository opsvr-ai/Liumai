"""Test bootstrap: settings and import path for backend unit tests."""

from __future__ import annotations

import os
import sys
from pathlib import Path

os.environ.setdefault("JWT_SECRET", "test-jwt-secret-not-for-production-0123456789")
os.environ.setdefault(
    "DATABASE_URL",
    "postgresql+asyncpg://test:test@127.0.0.1:5432/liumai_test",
)

# Make ``app`` importable when pytest is invoked from the repository root.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
