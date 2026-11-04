data "aws_ec2_managed_prefix_list" "cloudfront" { name = "com.amazonaws.global.cloudfront.origin-facing" }
resource "aws_security_group" "alb" {
  name_prefix = "${local.name}-alb-"
  description = "TLS exclusively from CloudFront origin-facing networks"
  vpc_id      = aws_vpc.main.id
  ingress {
    from_port       = 443
    to_port         = 443
    protocol        = "tcp"
    prefix_list_ids = [data.aws_ec2_managed_prefix_list.cloudfront.id]
  }
  egress {
    from_port       = 5000
    to_port         = 5000
    protocol        = "tcp"
    security_groups = [aws_security_group.app.id]
  }
}
resource "aws_security_group" "app" {
  name_prefix = "${local.name}-app-"
  description = "Private backend; no SSH ingress"
  vpc_id      = aws_vpc.main.id

}
resource "aws_security_group_rule" "app_https" {
  type              = "egress"
  from_port         = 443
  to_port           = 443
  protocol          = "tcp"
  cidr_blocks       = ["0.0.0.0/0"]
  description       = "TLS for endpoints, SSM and signed package updates"
  security_group_id = aws_security_group.app.id
}
resource "aws_security_group_rule" "app_from_alb" {
  type                     = "ingress"
  from_port                = 5000
  to_port                  = 5000
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.alb.id
  security_group_id        = aws_security_group.app.id
}
resource "aws_security_group_rule" "app_to_db" {
  type                     = "egress"
  from_port                = 1433
  to_port                  = 1433
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.database.id
  security_group_id        = aws_security_group.app.id
}
resource "aws_security_group" "database" {
  name_prefix = "${local.name}-db-"
  description = "SQL Server accepts backend security group only"
  vpc_id      = aws_vpc.main.id
  ingress {
    from_port       = 1433
    to_port         = 1433
    protocol        = "tcp"
    security_groups = [aws_security_group.app.id]
  }
  # RDS manages Multi-AZ replication; no client/VPC-CIDR or public access.
}
resource "aws_security_group" "endpoint" {
  name_prefix = "${local.name}-vpce-"
  vpc_id      = aws_vpc.main.id
  ingress {
    from_port       = 443
    to_port         = 443
    protocol        = "tcp"
    security_groups = [aws_security_group.app.id]
  }
}
resource "aws_iam_role" "ec2" {
  name_prefix        = "${local.name}-ec2-"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = "sts:AssumeRole", Principal = { Service = "ec2.amazonaws.com" } }] })
}
resource "aws_iam_instance_profile" "ec2" { role = aws_iam_role.ec2.name }
resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.ec2.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}
resource "aws_iam_role_policy" "application" {
  role = aws_iam_role.ec2.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat([
      { Effect = "Allow", Action = ["s3:GetObject"], Resource = "${aws_s3_bucket.backend.arn}/${var.backend_release_key}" },
      { Effect = "Allow", Action = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"], Resource = concat([var.app_secret_arn], local.database_secret_arns) },
      { Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams"], Resource = "${aws_cloudwatch_log_group.app.arn}:*" }
      ], length(local.secret_kms_keys) == 0 ? [] : [
      { Effect = "Allow", Action = ["kms:Decrypt"], Resource = local.secret_kms_keys, Condition = { StringEquals = { "kms:ViaService" = "secretsmanager.${var.aws_region}.amazonaws.com" } } }
    ])
  })
}

# The shared origin header is sensitive and lives in Terraform state. It blocks
# requests from other CloudFront distributions sharing the managed prefix list.
resource "random_password" "origin" {
  length  = 48
  special = false
}
