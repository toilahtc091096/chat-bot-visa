FROM python:3.12-slim
WORKDIR /app
ENV PYTHONUNBUFFERED=1
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app
COPY public ./public
COPY run.py ./
ENV DATA_DIR=/app/data HOST=0.0.0.0
VOLUME ["/app/data"]
EXPOSE 3000
CMD ["python", "run.py"]
