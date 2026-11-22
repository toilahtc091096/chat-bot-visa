"""Chạy web: python run.py"""
import uvicorn

from app.config import config

if __name__ == "__main__":
    uvicorn.run("app.main:app", host=config.host, port=config.port, workers=1)
