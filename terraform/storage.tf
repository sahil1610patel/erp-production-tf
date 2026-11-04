resource "aws_s3_bucket" "backend" {
  bucket_prefix = "${local.name}-releases-"
  force_destroy = false
}
resource "aws_s3_bucket" "frontend" {
  bucket_prefix = "${local.name}-frontend-"
  force_destroy = false
}
locals { buckets = { backend = aws_s3_bucket.backend.id, frontend = aws_s3_bucket.frontend.id } }
resource "aws_s3_bucket_public_access_block" "all" {
  for_each                = local.buckets
  bucket                  = each.value
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_versioning" "all" {
  for_each = local.buckets
  bucket   = each.value
  versioning_configuration { status = "Enabled" }
}
resource "aws_s3_bucket_server_side_encryption_configuration" "all" {
  for_each = local.buckets
  bucket   = each.value
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}
resource "aws_s3_bucket_ownership_controls" "all" {
  for_each = local.buckets
  bucket   = each.value
  rule { object_ownership = "BucketOwnerEnforced" }
}
resource "aws_s3_bucket_policy" "backend" {
  bucket = aws_s3_bucket.backend.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [{ Sid = "RequireTLS", Effect = "Deny", Principal = "*", Action = "s3:*", Resource = [aws_s3_bucket.backend.arn, "${aws_s3_bucket.backend.arn}/*"], Condition = { Bool = { "aws:SecureTransport" = "false" } } }] })
}
resource "aws_s3_bucket_policy" "frontend" {
  bucket = aws_s3_bucket.frontend.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Sid = "RequireTLS", Effect = "Deny", Principal = "*", Action = "s3:*", Resource = [aws_s3_bucket.frontend.arn, "${aws_s3_bucket.frontend.arn}/*"], Condition = { Bool = { "aws:SecureTransport" = "false" } } },
    { Sid = "CloudFrontRead", Effect = "Allow", Principal = { Service = "cloudfront.amazonaws.com" }, Action = "s3:GetObject", Resource = "${aws_s3_bucket.frontend.arn}/*", Condition = { StringEquals = { "AWS:SourceArn" = aws_cloudfront_distribution.erp.arn } } }
  ] })
}
