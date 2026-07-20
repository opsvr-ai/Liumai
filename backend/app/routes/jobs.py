"""Proxy endpoints for Hermes Jobs API — background scheduled work."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import JSONResponse

from app.auth import require_admin
from app.models import User

router = APIRouter()


async def _proxy(
    method: str,
    path: str,
    body: dict | None = None,
    params: dict | None = None,
) -> JSONResponse:
    """Forward a request to the Hermes Jobs API and return its response.

    Jobs API lives at the root ``/api/jobs`` path, NOT under ``/v1/``.
    We strip any trailing ``/v1`` (or ``/v1/``) from the configured
    Hermes URL before appending the jobs path.
    """
    from app.services.hermes import _hermes_url, _hermes_api_key

    import httpx
    import re

    base = _hermes_url.rstrip("/")
    # Strip /v1 suffix so we hit the root-level /api/jobs endpoint
    base = re.sub(r"/v1$", "", base)

    url = f"{base}/api/jobs{path}"
    headers: dict[str, str] = {}
    if _hermes_api_key:
        headers["Authorization"] = f"Bearer {_hermes_api_key}"

    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(30.0, connect=10.0)) as client:
            if method == "GET":
                resp = await client.get(url, headers=headers, params=params)
            elif method == "POST":
                resp = await client.post(url, headers=headers, json=body)
            elif method == "PATCH":
                resp = await client.patch(url, headers=headers, json=body)
            elif method == "DELETE":
                resp = await client.delete(url, headers=headers)
            else:
                raise HTTPException(status_code=400, detail=f"Unsupported method: {method}")

        try:
            data = resp.json()
        except Exception:
            data = {"detail": resp.text[:500]}

        return JSONResponse(content=data, status_code=resp.status_code)
    except httpx.ConnectError:
        raise HTTPException(status_code=502, detail="无法连接到 Hermes 服务")
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="Hermes 请求超时")


# ── List / Create ──────────────────────────────────────────────────────────

@router.get("")
async def list_jobs(
    include_disabled: bool = False,
    _admin: User = Depends(require_admin),
):
    """List all cron jobs."""
    return await _proxy("GET", "", params={"include_disabled": str(include_disabled).lower()})


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_job(
    body: dict,
    _admin: User = Depends(require_admin),
):
    """Create a new cron job."""
    return await _proxy("POST", "", body=body)


# ── Single job ─────────────────────────────────────────────────────────────

@router.get("/{job_id}")
async def get_job(
    job_id: str,
    _admin: User = Depends(require_admin),
):
    """Get a single job by ID."""
    return await _proxy("GET", f"/{job_id}")


@router.patch("/{job_id}")
async def update_job(
    job_id: str,
    body: dict,
    _admin: User = Depends(require_admin),
):
    """Update an existing job."""
    return await _proxy("PATCH", f"/{job_id}", body=body)


@router.delete("/{job_id}")
async def delete_job(
    job_id: str,
    _admin: User = Depends(require_admin),
):
    """Delete a job."""
    return await _proxy("DELETE", f"/{job_id}")


# ── Actions ────────────────────────────────────────────────────────────────

@router.post("/{job_id}/pause")
async def pause_job(
    job_id: str,
    _admin: User = Depends(require_admin),
):
    """Pause a scheduled job."""
    return await _proxy("POST", f"/{job_id}/pause")


@router.post("/{job_id}/resume")
async def resume_job(
    job_id: str,
    _admin: User = Depends(require_admin),
):
    """Resume a paused job."""
    return await _proxy("POST", f"/{job_id}/resume")


@router.post("/{job_id}/run")
async def run_job(
    job_id: str,
    _admin: User = Depends(require_admin),
):
    """Trigger immediate execution of a job."""
    return await _proxy("POST", f"/{job_id}/run")
