# syntax=docker/dockerfile:1.7

FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src

# Copy solution + project files first to exploit Docker layer caching on restore.
COPY FamilienKochbuch.sln Directory.Build.props ./
COPY src/FamilienKochbuch.Api/FamilienKochbuch.Api.csproj src/FamilienKochbuch.Api/
COPY src/FamilienKochbuch.Domain/FamilienKochbuch.Domain.csproj src/FamilienKochbuch.Domain/
COPY src/FamilienKochbuch.Infrastructure/FamilienKochbuch.Infrastructure.csproj src/FamilienKochbuch.Infrastructure/
COPY tests/FamilienKochbuch.Api.Tests/FamilienKochbuch.Api.Tests.csproj tests/FamilienKochbuch.Api.Tests/
COPY tests/FamilienKochbuch.Domain.Tests/FamilienKochbuch.Domain.Tests.csproj tests/FamilienKochbuch.Domain.Tests/
COPY tests/FamilienKochbuch.Infrastructure.Tests/FamilienKochbuch.Infrastructure.Tests.csproj tests/FamilienKochbuch.Infrastructure.Tests/
RUN dotnet restore src/FamilienKochbuch.Api/FamilienKochbuch.Api.csproj

COPY src/ src/
RUN dotnet publish src/FamilienKochbuch.Api/FamilienKochbuch.Api.csproj -c Release -o /app --no-restore

FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS runtime
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build --chown=app:app /app .
USER app
EXPOSE 5000
ENV ASPNETCORE_HTTP_PORTS=5000 \
    ASPNETCORE_URLS=http://+:5000 \
    ASPNETCORE_ENVIRONMENT=Production
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=5 \
  CMD curl --fail --silent http://localhost:5000/api/health || exit 1
ENTRYPOINT ["dotnet", "FamilienKochbuch.Api.dll"]
