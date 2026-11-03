# Automatically fetch the valid default version of SQL Server Standard in ca-central-1
data "aws_rds_engine_version" "sqlserver_se" {
  engine       = "sqlserver-se"
  default_only = true
}

resource "aws_db_subnet_group" "rds_subnets" {
  name       = "${var.project_name}-rds-subnet-group"
  subnet_ids = [aws_subnet.private_db_az1.id, aws_subnet.private_db_az2.id]
  tags       = { Name = "${var.project_name}-rds-subnet-group" }
}

# Production Multi-AZ RDS SQL Server Standard Instance
resource "aws_db_instance" "erp_rds" {
  identifier            = "${var.project_name}-sqlserver"
  engine                = "sqlserver-se"
  engine_version        = data.aws_rds_engine_version.sqlserver_se.version
  instance_class        = "db.m5.large"
  license_model         = "license-included"

  allocated_storage     = 20
  max_allocated_storage = 100
  storage_type          = "gp3"
  storage_encrypted     = true

  username              = var.db_username
  password              = random_password.db_password.result
  port                  = 1433

  # High Availability (Multi-AZ Mirroring / Always On requires backup_retention_period > 0)
  multi_az                = true
  backup_retention_period = 7
  db_subnet_group_name    = aws_db_subnet_group.rds_subnets.name
  vpc_security_group_ids  = [aws_security_group.rds_sg.id]
  publicly_accessible     = false

  skip_final_snapshot     = true
  deletion_protection     = false

  tags = { Name = "${var.project_name}-rds-multiaz" }
}

# Store Credentials AND Live RDS Host Endpoint in AWS Secrets Manager
resource "aws_secretsmanager_secret" "db_secret" {
  name_prefix             = "${var.project_name}-db-secret-"
  recovery_window_in_days = 0 # Allows instant recreation/deletion without 30-day lock
}

resource "aws_secretsmanager_secret_version" "db_secret_val" {
  secret_id = aws_secretsmanager_secret.db_secret.id
  secret_string = jsonencode({
    username = var.db_username
    password = random_password.db_password.result
    host     = aws_db_instance.erp_rds.address
    port     = 1433
  })
}