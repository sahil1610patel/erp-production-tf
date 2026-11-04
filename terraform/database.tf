resource "aws_db_subnet_group" "erp" {
  name       = "${local.name}-database"
  subnet_ids = [for subnet in aws_subnet.database : subnet.id]
}
resource "random_id" "snapshot" { byte_length = 4 }
resource "aws_db_instance" "erp" {
  identifier                            = "${local.name}-sqlserver"
  engine                                = "sqlserver-se"
  engine_version                        = var.db_engine_version
  instance_class                        = var.db_instance_class
  license_model                         = "license-included"
  allocated_storage                     = 100
  max_allocated_storage                 = 1000
  storage_type                          = "gp3"
  storage_encrypted                     = true
  username                              = "erpadmin"
  manage_master_user_password           = true
  port                                  = 1433
  multi_az                              = true
  publicly_accessible                   = false
  db_subnet_group_name                  = aws_db_subnet_group.erp.name
  vpc_security_group_ids                = [aws_security_group.database.id]
  backup_retention_period               = 35
  backup_window                         = "07:00-08:00"
  maintenance_window                    = "sun:08:30-sun:09:30"
  auto_minor_version_upgrade            = true
  apply_immediately                     = false
  copy_tags_to_snapshot                 = true
  deletion_protection                   = var.deletion_protection
  skip_final_snapshot                   = false
  final_snapshot_identifier             = "${local.name}-final-${random_id.snapshot.hex}"
  enabled_cloudwatch_logs_exports       = ["error", "agent"]
  performance_insights_enabled          = true
  performance_insights_retention_period = 7
}
