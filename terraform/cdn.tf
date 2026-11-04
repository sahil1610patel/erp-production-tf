data "aws_cloudfront_cache_policy" "static" { name = "Managed-CachingOptimized" }
data "aws_cloudfront_cache_policy" "api" { name = "Managed-CachingDisabled" }
data "aws_cloudfront_origin_request_policy" "api" { name = "Managed-AllViewerExceptHostHeader" }
resource "aws_cloudfront_origin_access_control" "frontend" {
  name                              = "${local.name}-frontend"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}
resource "aws_cloudfront_response_headers_policy" "security" {
  name = "${local.name}-security"
  security_headers_config {
    content_type_options { override = true }
    frame_options {
      frame_option = "DENY"
      override     = true
    }
    referrer_policy {
      referrer_policy = "same-origin"
      override        = true
    }
    strict_transport_security {
      access_control_max_age_sec = 31536000
      include_subdomains         = true
      override                   = true
    }
    content_security_policy {
      content_security_policy = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; object-src 'none'"
      override                = true
    }
  }
}
resource "aws_cloudfront_distribution" "erp" {
  enabled             = true
  is_ipv6_enabled     = true
  comment             = "${local.name} single HTTPS application entry point"
  default_root_object = "index.html"
  price_class         = "PriceClass_100"
  http_version        = "http2and3"
  web_acl_id          = aws_wafv2_web_acl.edge.arn
  origin {
    domain_name              = aws_s3_bucket.frontend.bucket_regional_domain_name
    origin_id                = "frontend"
    origin_access_control_id = aws_cloudfront_origin_access_control.frontend.id
  }
  origin {
    domain_name = var.origin_domain_name
    origin_id   = "api"
    custom_header {
      name  = "X-Origin-Verify"
      value = random_password.origin.result
    }
    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
      origin_read_timeout    = 60
    }
  }
  default_cache_behavior {
    target_origin_id           = "frontend"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD", "OPTIONS"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = data.aws_cloudfront_cache_policy.static.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security.id
  }
  # API errors remain API errors: never rewrite 403/404/502 to index.html.
  dynamic "ordered_cache_behavior" {
    for_each = ["/api/*", "/api", "/health"]
    content {
      path_pattern               = ordered_cache_behavior.value
      target_origin_id           = "api"
      viewer_protocol_policy     = "https-only"
      allowed_methods            = ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"]
      cached_methods             = ["GET", "HEAD"]
      compress                   = true
      cache_policy_id            = data.aws_cloudfront_cache_policy.api.id
      origin_request_policy_id   = data.aws_cloudfront_origin_request_policy.api.id
      response_headers_policy_id = aws_cloudfront_response_headers_policy.security.id
    }
  }
  restrictions {
    geo_restriction { restriction_type = "none" }
  }
  viewer_certificate { cloudfront_default_certificate = true }
}

resource "aws_wafv2_web_acl" "edge" {
  provider = aws.global
  name     = "${local.name}-edge"
  scope    = "CLOUDFRONT"
  default_action {
    allow {}
  }
  rule {
    name     = "managed-common"
    priority = 10
    override_action {
      none {}
    }
    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesCommonRuleSet"
        vendor_name = "AWS"
        rule_action_override {
          name = "SizeRestrictions_BODY"
          action_to_use {
            count {}
          }
        }
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      sampled_requests_enabled   = false
      metric_name                = "${local.name}-common"
    }
  }
  rule {
    name     = "login-rate-limit"
    priority = 5
    action {
      block {}
    }
    statement {
      rate_based_statement {
        limit                 = 100
        aggregate_key_type    = "IP"
        evaluation_window_sec = 300
        scope_down_statement {
          byte_match_statement {
            positional_constraint = "EXACTLY"
            search_string         = "/api/auth/login"
            field_to_match {
              uri_path {}
            }
            text_transformation {
              priority = 0
              type     = "LOWERCASE"
            }
          }
        }
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      sampled_requests_enabled   = false
      metric_name                = "${local.name}-login-rate"
    }
  }
  visibility_config {
    cloudwatch_metrics_enabled = true
    sampled_requests_enabled   = false
    metric_name                = "${local.name}-waf"
  }
}
