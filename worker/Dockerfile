FROM rclone/rclone:latest AS rclone
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends fonts-dejavu-core ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=rclone /usr/local/bin/rclone /usr/local/bin/rclone
WORKDIR /app
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt
RUN python -m playwright install --with-deps chromium
COPY app.py /app/app.py
COPY job_source.py /app/job_source.py
RUN mkdir -p /config/rclone
EXPOSE 8080
CMD ["uvicorn", "app:APP", "--host", "0.0.0.0", "--port", "8080", "--workers", "1"]