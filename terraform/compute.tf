data "aws_ami" "linux" {
  most_recent = true
  owners      = ["amazon"]
  filter {
    name   = "name"
    values = ["al2023-ami-2023.*-x86_64"]
  }
  filter {
    name   = "architecture"
    values = ["x86_64"]
  }
}
resource "aws_lb" "app" {
  name                       = "${local.name}-alb"
  internal                   = false
  load_balancer_type         = "application"
  security_groups            = [aws_security_group.alb.id]
  subnets                    = [for subnet in aws_subnet.public : subnet.id]
  drop_invalid_header_fields = true
  enable_deletion_protection = var.deletion_protection
  idle_timeout               = 60
}
resource "aws_lb_target_group" "app" {
  name_prefix          = "erp-"
  port                 = 5000
  protocol             = "HTTP"
  vpc_id               = aws_vpc.main.id
  deregistration_delay = 60
  health_check {
    path                = "/health"
    matcher             = "200"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
  lifecycle { create_before_destroy = true }
}
resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.app.arn
  port              = 443
  protocol          = "HTTPS"
  certificate_arn   = var.origin_certificate_arn
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  default_action {
    type = "fixed-response"
    fixed_response {
      content_type = "application/json"
      message_body = "{\"error\":\"Forbidden origin\"}"
      status_code  = "403"
    }
  }
}
resource "aws_lb_listener_rule" "cloudfront" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 10
  condition {
    http_header {
      http_header_name = "X-Origin-Verify"
      values           = [random_password.origin.result]
    }
  }
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }
}
resource "aws_route53_record" "origin" {
  count   = var.origin_route53_zone_id == null ? 0 : 1
  zone_id = var.origin_route53_zone_id
  name    = var.origin_domain_name
  type    = "A"
  alias {
    name                   = aws_lb.app.dns_name
    zone_id                = aws_lb.app.zone_id
    evaluate_target_health = true
  }
}
resource "aws_launch_template" "app" {
  name_prefix            = "${local.name}-"
  image_id               = data.aws_ami.linux.id
  instance_type          = var.instance_type
  update_default_version = true
  vpc_security_group_ids = [aws_security_group.app.id]
  iam_instance_profile { name = aws_iam_instance_profile.ec2.name }
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }
  block_device_mappings {
    device_name = "/dev/xvda"
    ebs {
      volume_size           = 30
      volume_type           = "gp3"
      encrypted             = true
      delete_on_termination = true
    }
  }
  user_data = base64encode(templatefile("${path.module}/templates/user_data.sh.tftpl", {
    region         = var.aws_region
    node_version   = var.node_version
    release_bucket = aws_s3_bucket.backend.id
    release_key    = var.backend_release_key
    release_sha256 = var.backend_release_sha256
    log_group      = aws_cloudwatch_log_group.app.name
    environment_json_b64 = base64encode(jsonencode({
      NODE_ENV              = var.environment == "production" ? "production" : "development"
      PORT                  = "5000"
      AWS_REGION            = var.aws_region
      SECRET_ID             = local.database_secret_arn
      DB_HOST               = aws_db_instance.erp.address
      DB_CA_BUNDLE          = "/etc/erp/rds-ca.pem"
      DB_PORT               = "1433"
      DB_NAME               = "ERP_DB"
      APP_SECRET_ID         = var.app_secret_arn
      CREATE_DATABASE       = tostring(var.bootstrap_database)
      AUTO_MIGRATE          = tostring(var.bootstrap_database)
      BOOTSTRAP_ADMIN_EMAIL = var.bootstrap_database ? var.bootstrap_admin_email : ""
      ENABLE_DEMO_SEED      = "false"
    }))
  }))
  tag_specifications {
    resource_type = "instance"
    tags          = { Name = "${local.name}-api" }
  }
  lifecycle {
    precondition {
      condition     = var.desired_capacity == 0 || var.backend_release_sha256 != "0000000000000000000000000000000000000000000000000000000000000000"
      error_message = "Set desired_capacity=0 for initial bootstrap or supply the real backend release SHA256."
    }
    precondition {
      condition     = var.desired_capacity == 0 || var.bootstrap_database || var.runtime_db_secret_arn != null
      error_message = "Supply runtime_db_secret_arn or explicitly enable temporary bootstrap_database mode."
    }
  }
}
resource "aws_autoscaling_group" "app" {
  name                      = "${local.name}-api"
  min_size                  = var.desired_capacity == 0 ? 0 : 2
  max_size                  = 6
  desired_capacity          = var.desired_capacity
  vpc_zone_identifier       = [for subnet in aws_subnet.app : subnet.id]
  target_group_arns         = [aws_lb_target_group.app.arn]
  health_check_type         = "ELB"
  health_check_grace_period = 900
  default_instance_warmup   = 300
  wait_for_capacity_timeout = "20m"
  launch_template {
    id      = aws_launch_template.app.id
    version = tostring(aws_launch_template.app.latest_version)
  }
  instance_refresh {
    strategy = "Rolling"
    preferences {
      min_healthy_percentage = 100
      max_healthy_percentage = 150
      instance_warmup        = 300
      auto_rollback          = true
    }
  }
  tag {
    key                 = "Name"
    value               = "${local.name}-api"
    propagate_at_launch = true
  }
  depends_on = [aws_iam_role_policy.application, aws_vpc_endpoint.secrets, aws_route_table_association.app, aws_lb_listener_rule.cloudfront]
}
resource "aws_autoscaling_policy" "cpu" {
  name                   = "${local.name}-cpu"
  autoscaling_group_name = aws_autoscaling_group.app.name
  policy_type            = "TargetTrackingScaling"
  target_tracking_configuration {
    predefined_metric_specification { predefined_metric_type = "ASGAverageCPUUtilization" }
    target_value = 60
  }
}
