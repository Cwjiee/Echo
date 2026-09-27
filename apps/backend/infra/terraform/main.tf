terraform {
  required_version = ">= 1.8"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

# ── Variables ──────────────────────────────────────────────────────────────

variable "aws_region" { default = "us-east-1" }
variable "app_name"   { default = "echo" }
variable "db_password" { sensitive = true }

# ── ECS Fargate Cluster ────────────────────────────────────────────────────

resource "aws_ecs_cluster" "echo" {
  name = "${var.app_name}-cluster"
}

resource "aws_ecs_task_definition" "backend" {
  family                   = "${var.app_name}-backend"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "512"
  memory                   = "1024"

  container_definitions = jsonencode([{
    name      = "backend"
    image     = "${var.app_name}-backend:latest"  # Replace with ECR URI
    essential = true
    portMappings = [{ containerPort = 8000, protocol = "tcp" }]
    environment = [
      { name = "DATABASE_URL", value = "postgresql+asyncpg://${var.app_name}:${var.db_password}@${aws_db_instance.postgres.endpoint}/echo" },
      { name = "REDIS_URL",    value = "redis://${aws_elasticache_cluster.redis.cache_nodes[0].address}:6379/0" }
    ]
  }])
}

# ── RDS Postgres ───────────────────────────────────────────────────────────

resource "aws_db_instance" "postgres" {
  identifier        = "${var.app_name}-db"
  engine            = "postgres"
  engine_version    = "16"
  instance_class    = "db.t3.micro"
  allocated_storage = 20
  db_name           = var.app_name
  username          = var.app_name
  password          = var.db_password
  skip_final_snapshot = true
}

# ── ElastiCache Redis ──────────────────────────────────────────────────────

resource "aws_elasticache_cluster" "redis" {
  cluster_id           = "${var.app_name}-redis"
  engine               = "redis"
  node_type            = "cache.t3.micro"
  num_cache_nodes      = 1
  parameter_group_name = "default.redis7"
  port                 = 6379
}

# ── Outputs ────────────────────────────────────────────────────────────────

output "backend_cluster" { value = aws_ecs_cluster.echo.name }
output "db_endpoint"     { value = aws_db_instance.postgres.endpoint }
