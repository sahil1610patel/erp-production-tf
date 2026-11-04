resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = local.name }
}
resource "aws_internet_gateway" "main" { vpc_id = aws_vpc.main.id }
resource "aws_subnet" "public" {
  for_each                = local.az_map
  vpc_id                  = aws_vpc.main.id
  availability_zone       = each.value
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, tonumber(each.key))
  map_public_ip_on_launch = false
  tags                    = { Name = "${local.name}-public-${each.key}" }
}
resource "aws_subnet" "app" {
  for_each          = local.az_map
  vpc_id            = aws_vpc.main.id
  availability_zone = each.value
  cidr_block        = cidrsubnet(var.vpc_cidr, 8, 10 + tonumber(each.key))
  tags              = { Name = "${local.name}-app-${each.key}" }
}
resource "aws_subnet" "database" {
  for_each          = local.az_map
  vpc_id            = aws_vpc.main.id
  availability_zone = each.value
  cidr_block        = cidrsubnet(var.vpc_cidr, 8, 20 + tonumber(each.key))
  tags              = { Name = "${local.name}-db-${each.key}" }
}
resource "aws_eip" "nat" {
  for_each = local.az_map
  domain   = "vpc"
}
resource "aws_nat_gateway" "main" {
  for_each      = local.az_map
  allocation_id = aws_eip.nat[each.key].id
  subnet_id     = aws_subnet.public[each.key].id
  depends_on    = [aws_internet_gateway.main]
}
resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }
}
resource "aws_route_table_association" "public" {
  for_each       = local.az_map
  subnet_id      = aws_subnet.public[each.key].id
  route_table_id = aws_route_table.public.id
}
resource "aws_route_table" "app" {
  for_each = local.az_map
  vpc_id   = aws_vpc.main.id
  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.main[each.key].id
  }
}
resource "aws_route_table_association" "app" {
  for_each       = local.az_map
  subnet_id      = aws_subnet.app[each.key].id
  route_table_id = aws_route_table.app[each.key].id
}
# Database tier has VPC-local routes only. No route to NAT or Internet Gateway.
resource "aws_route_table" "database" { vpc_id = aws_vpc.main.id }
resource "aws_route_table_association" "database" {
  for_each       = local.az_map
  subnet_id      = aws_subnet.database[each.key].id
  route_table_id = aws_route_table.database.id
}
resource "aws_vpc_endpoint" "secrets" {
  vpc_id              = aws_vpc.main.id
  service_name        = "com.amazonaws.${var.aws_region}.secretsmanager"
  vpc_endpoint_type   = "Interface"
  private_dns_enabled = true
  subnet_ids          = [for subnet in aws_subnet.app : subnet.id]
  security_group_ids  = [aws_security_group.endpoint.id]
  policy              = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = "*", Action = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"], Resource = concat([var.app_secret_arn], local.database_secret_arns), Condition = { ArnEquals = { "aws:PrincipalArn" = aws_iam_role.ec2.arn } } }] })
}
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.main.id
  service_name      = "com.amazonaws.${var.aws_region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [for rt in aws_route_table.app : rt.id]
}
