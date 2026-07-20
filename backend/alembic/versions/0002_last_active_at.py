"""add last_active_at to users

Revision ID: 0002_last_active_at
Revises: 0001_avatar_url
Create Date: 2026-07-21
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = '0002_last_active_at'
down_revision: Union[str, None] = '0001_avatar_url'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

def upgrade() -> None:
    op.add_column('users', sa.Column('last_active_at', sa.DateTime(timezone=True), nullable=True))

def downgrade() -> None:
    op.drop_column('users', 'last_active_at')
