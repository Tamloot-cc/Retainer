# A VPC of its own. The api, consolidate and ops functions run in two private
# subnets with no route out: the database is reachable only from the
# functions, and they make no outbound calls (Retainer never calls a model or
# any other service). API Gateway reaches them through Lambda.
#
# In accounts mode the control function signs people in with Google or
# Microsoft (login.microsoftonline.com) and fetches OAuth client metadata
# documents, which needs the internet. It runs in private subnets of its own
# whose only route out is a NAT gateway in a public subnet, so the other
# functions still have none (accounts spec 4.6).

data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  azs = slice(data.aws_availability_zones.available.names, 0, 2)
}

resource "aws_vpc" "this" {
  cidr_block           = "10.42.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = var.name }
}

# AWS creates the VPC's main route table and default network ACL with it.
# Terraform leaves them as they are, but tags them like everything else, so
# every network resource of this deployment carries Application = name.
resource "aws_ec2_tag" "vpc_defaults" {
  for_each = {
    main_route_table    = aws_vpc.this.main_route_table_id
    default_network_acl = aws_vpc.this.default_network_acl_id
  }
  resource_id = each.value
  key         = "Application"
  value       = var.name
}

# The VPC's default security group allows all traffic between its members.
# Nothing uses it; strip its rules so nothing can by accident.
resource "aws_default_security_group" "this" {
  vpc_id = aws_vpc.this.id
}

resource "aws_subnet" "private" {
  count             = length(local.azs)
  vpc_id            = aws_vpc.this.id
  availability_zone = local.azs[count.index]
  cidr_block        = cidrsubnet(aws_vpc.this.cidr_block, 8, count.index)

  tags = { Name = "${var.name}-private-${local.azs[count.index]}" }
}

resource "aws_security_group" "functions" {
  name        = "${var.name}-functions"
  description = "Retainer functions: may reach the database only"
  vpc_id      = aws_vpc.this.id
}

resource "aws_vpc_security_group_egress_rule" "functions_to_database" {
  security_group_id            = aws_security_group.functions.id
  referenced_security_group_id = aws_security_group.database.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  description                  = "Postgres"
}

resource "aws_security_group" "database" {
  name        = "${var.name}-database"
  description = "Retainer database: reachable from the functions only"
  vpc_id      = aws_vpc.this.id
}

resource "aws_vpc_security_group_ingress_rule" "database_from_functions" {
  security_group_id            = aws_security_group.database.id
  referenced_security_group_id = aws_security_group.functions.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  description                  = "Postgres from the functions"
}

# ─── Accounts mode: the control function's way out ───────────────────────────

resource "aws_security_group" "control" {
  count = local.accounts ? 1 : 0
  name  = "${var.name}-control"
  # Also HTTPS for Microsoft sign-in and client metadata (control_https).
  # Changing a group's description replaces the group, so it stays as is.
  description = "Retainer control function: the database, and HTTPS out for Google sign-in"
  vpc_id      = aws_vpc.this.id
}

resource "aws_vpc_security_group_egress_rule" "control_to_database" {
  count                        = local.accounts ? 1 : 0
  security_group_id            = aws_security_group.control[0].id
  referenced_security_group_id = aws_security_group.database.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  description                  = "Postgres"
}

resource "aws_vpc_security_group_egress_rule" "control_https" {
  count             = local.accounts ? 1 : 0
  security_group_id = aws_security_group.control[0].id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  description       = "HTTPS: Google and Microsoft sign-in, OAuth client metadata"
}

resource "aws_vpc_security_group_ingress_rule" "database_from_control" {
  count                        = local.accounts ? 1 : 0
  security_group_id            = aws_security_group.database.id
  referenced_security_group_id = aws_security_group.control[0].id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  description                  = "Postgres from the control function"
}

resource "aws_internet_gateway" "this" {
  count  = local.accounts ? 1 : 0
  vpc_id = aws_vpc.this.id
  tags   = { Name = var.name }
}

# One NAT gateway, in the first zone: if that zone fails, signing in stops
# and the rest of Retainer keeps working.
resource "aws_subnet" "public" {
  count             = local.accounts ? 1 : 0
  vpc_id            = aws_vpc.this.id
  availability_zone = local.azs[0]
  cidr_block        = cidrsubnet(aws_vpc.this.cidr_block, 8, 100)

  tags = { Name = "${var.name}-public-${local.azs[0]}" }
}

resource "aws_route_table" "public" {
  count  = local.accounts ? 1 : 0
  vpc_id = aws_vpc.this.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.this[0].id
  }

  tags = { Name = "${var.name}-public" }
}

resource "aws_route_table_association" "public" {
  count          = local.accounts ? 1 : 0
  subnet_id      = aws_subnet.public[0].id
  route_table_id = aws_route_table.public[0].id
}

resource "aws_eip" "nat" {
  count  = local.accounts ? 1 : 0
  domain = "vpc"
  tags   = { Name = "${var.name}-nat" }
}

resource "aws_nat_gateway" "this" {
  count         = local.accounts ? 1 : 0
  allocation_id = aws_eip.nat[0].id
  subnet_id     = aws_subnet.public[0].id
  tags          = { Name = var.name }

  depends_on = [aws_internet_gateway.this]
}

resource "aws_subnet" "control" {
  count             = local.accounts ? length(local.azs) : 0
  vpc_id            = aws_vpc.this.id
  availability_zone = local.azs[count.index]
  cidr_block        = cidrsubnet(aws_vpc.this.cidr_block, 8, 10 + count.index)

  tags = { Name = "${var.name}-control-${local.azs[count.index]}" }
}

resource "aws_route_table" "control" {
  count  = local.accounts ? 1 : 0
  vpc_id = aws_vpc.this.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.this[0].id
  }

  tags = { Name = "${var.name}-control" }
}

resource "aws_route_table_association" "control" {
  count          = length(aws_subnet.control)
  subnet_id      = aws_subnet.control[count.index].id
  route_table_id = aws_route_table.control[0].id
}
