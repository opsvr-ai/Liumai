"""add avatar_url to users

Revision ID: 0001_avatar_url
Revises:
Create Date: 2026-07-20

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '0001_avatar_url'
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('users', sa.Column('avatar_url', sa.String(512), nullable=True))


def downgrade() -> None:
    op.drop_column('users', 'avatar_url')
