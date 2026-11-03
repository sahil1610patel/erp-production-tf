# 1. S3 Bucket for Backend Deployment Zip (Auto-zipped by Terraform)
resource "aws_s3_bucket" "backend_artifacts" {
  bucket_prefix = "${var.project_name}-backend-code-"
  force_destroy = true
}

data "archive_file" "backend_zip" {
  type        = "zip"
  source_dir  = "${path.module}/backend"
  output_path = "${path.module}/backend.zip"
}

resource "aws_s3_object" "backend_zip_upload" {
  bucket = aws_s3_bucket.backend_artifacts.id
  key    = "backend.zip"
  source = data.archive_file.backend_zip.output_path
  etag   = data.archive_file.backend_zip.output_md5
}

# 2. IAM Role & Instance Profile for EC2 (SSM + S3 + Secrets Manager)
resource "aws_iam_role" "ec2_role" {
  name_prefix = "${var.project_name}-ec2-role-"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "ssm_policy" {
  role       = aws_iam_role.ec2_role.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy" "app_permissions" {
  name = "${var.project_name}-app-policy"
  role = aws_iam_role.ec2_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
        Resource = [aws_secretsmanager_secret.db_secret.arn]
      },
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:ListBucket"]
        Resource = [aws_s3_bucket.backend_artifacts.arn, "${aws_s3_bucket.backend_artifacts.arn}/*"]
      }
    ]
  })
}

resource "aws_iam_instance_profile" "ec2_profile" {
  name_prefix = "${var.project_name}-profile-"
  role        = aws_iam_role.ec2_role.name
}

# 3. Application Load Balancer & Target Group
resource "aws_lb" "app_alb" {
  name               = "${var.project_name}-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb_sg.id]
  subnets            = [aws_subnet.public_az1.id, aws_subnet.public_az2.id]
}

resource "aws_lb_target_group" "app_tg" {
  name        = "${var.project_name}-tg"
  port        = 5000
  protocol    = "HTTP"
  vpc_id      = aws_vpc.main.id
  target_type = "instance"

  health_check {
    path                = "/health"
    protocol            = "HTTP"
    port                = "5000"
    healthy_threshold   = 2
    unhealthy_threshold = 5
    timeout             = 5
    interval            = 15
    matcher             = "200"
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.app_alb.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app_tg.arn
  }
}

# 4. Latest Amazon Linux 2023 AMI & Launch Template
data "aws_ami" "al2023" {
  most_recent = true
  owners      = ["amazon"]
  filter {
    name   = "name"
    values = ["al2023-ami-2023.*-x86_64"]
  }
}

resource "aws_launch_template" "backend_lt" {
  name_prefix   = "${var.project_name}-lt-"
  image_id      = data.aws_ami.al2023.id
  instance_type = "t3.small"

  iam_instance_profile {
    name = aws_iam_instance_profile.ec2_profile.name
  }

  vpc_security_group_ids = [aws_security_group.ec2_sg.id]

  user_data = base64encode(<<-EOF
    #!/bin/bash
    set -e
    dnf update -y
    dnf install -y nodejs npm unzip awscli

    # Install PM2 globally and unify PM2_HOME across all users (root, ssm-user, ec2-user)
    npm install -g pm2
    echo 'export PM2_HOME="/home/ec2-user/.pm2"' > /etc/profile.d/pm2.sh
    chmod +x /etc/profile.d/pm2.sh
    export PM2_HOME="/home/ec2-user/.pm2"

    mkdir -p /home/ec2-user/app
    cd /home/ec2-user/app

    aws s3 cp s3://${aws_s3_bucket.backend_artifacts.id}/backend.zip ./backend.zip --region ${var.aws_region}
    unzip -o backend.zip
    npm install --omit=dev

    chown -R ec2-user:ec2-user /home/ec2-user

    sudo -u ec2-user AWS_REGION="${var.aws_region}" SECRET_ID="${aws_secretsmanager_secret.db_secret.arn}" PORT="5000" PM2_HOME="/home/ec2-user/.pm2" pm2 start server.js --name "erp-api"
    sudo -u ec2-user PM2_HOME="/home/ec2-user/.pm2" pm2 save
    env PATH=$PATH:/usr/bin pm2 startup systemd -u ec2-user --hp /home/ec2-user
  EOF
  )

  depends_on = [
    aws_s3_object.backend_zip_upload,
    aws_secretsmanager_secret_version.db_secret_val,
    aws_vpc_endpoint.secretsmanager
  ]
}

# 5. Auto Scaling Group Across Both Private App Subnets
resource "aws_autoscaling_group" "backend_asg" {
  name                = "${var.project_name}-asg"
  desired_capacity    = 2
  min_size            = 2
  max_size            = 4
  vpc_zone_identifier = [aws_subnet.private_app_az1.id, aws_subnet.private_app_az2.id]
  target_group_arns   = [aws_lb_target_group.app_tg.arn]

  launch_template {
    id      = aws_launch_template.backend_lt.id
    version = "$Latest"
  }

  tag {
    key                 = "Name"
    value               = "${var.project_name}-backend-instance"
    propagate_at_launch = true
  }
}

# 6. S3 Frontend Bucket + CloudFront with Dual Origins (S3 UI + ALB API)
resource "aws_s3_bucket" "frontend_bucket" {
  bucket_prefix = "${var.project_name}-frontend-"
  force_destroy = true
}

resource "aws_s3_object" "frontend_index" {
  bucket       = aws_s3_bucket.frontend_bucket.id
  key          = "index.html"
  source       = "${path.module}/frontend/index.html"
  content_type = "text/html"
  etag         = filemd5("${path.module}/frontend/index.html")
}

resource "aws_cloudfront_origin_access_control" "s3_oac" {
  name                              = "${var.project_name}-oac"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_distribution" "erp_cdn" {
  enabled             = true
  default_root_object = "index.html"

  # Origin 1: S3 Frontend
  origin {
    domain_name              = aws_s3_bucket.frontend_bucket.bucket_regional_domain_name
    origin_id                = "S3FrontendOrigin"
    origin_access_control_id = aws_cloudfront_origin_access_control.s3_oac.id
  }

  # Origin 2: ALB Backend API
  origin {
    domain_name = aws_lb.app_alb.dns_name
    origin_id   = "ALBBackendOrigin"

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "http-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  # Default Behavior -> S3 React Frontend
  default_cache_behavior {
    target_origin_id       = "S3FrontendOrigin"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]

    forwarded_values {
      query_string = false
      cookies { forward = "none" }
    }
  }

  # Route /api/* directly to ALB Backend (No CORS or Mixed Content!)
  ordered_cache_behavior {
    path_pattern           = "/api/*"
    target_origin_id       = "ALBBackendOrigin"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods         = ["GET", "HEAD"]

    default_ttl = 0
    min_ttl     = 0
    max_ttl     = 0

    forwarded_values {
      query_string = true
      headers      = ["*"]
      cookies { forward = "all" }
    }
  }

  # Route /health to ALB so you can inspect DB health right from your browser
  ordered_cache_behavior {
    path_pattern           = "/health"
    target_origin_id       = "ALBBackendOrigin"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    default_ttl            = 0
    min_ttl                = 0
    max_ttl                = 0

    forwarded_values {
      query_string = true
      headers      = ["*"]
      cookies { forward = "none" }
    }
  }

  restrictions {
    geo_restriction { restriction_type = "none" }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }
}

resource "aws_s3_bucket_policy" "frontend_policy" {
  bucket = aws_s3_bucket.frontend_bucket.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "cloudfront.amazonaws.com" }
      Action    = "s3:GetObject"
      Resource  = "${aws_s3_bucket.frontend_bucket.arn}/*"
      Condition = {
        StringEquals = {
          "AWS:SourceArn" = aws_cloudfront_distribution.erp_cdn.arn
        }
      }
    }]
  })
}

# Outputs
output "cloudfront_erp_url" {
  description = "Live HTTPS URL for your ERP Application"
  value       = "https://${aws_cloudfront_distribution.erp_cdn.domain_name}"
}

output "cloudfront_health_check_url" {
  description = "Live URL to check Backend & RDS connection status"
  value       = "https://${aws_cloudfront_distribution.erp_cdn.domain_name}/health"
}

output "rds_endpoint" {
  description = "Multi-AZ RDS SQL Server Endpoint"
  value       = aws_db_instance.erp_rds.address
}