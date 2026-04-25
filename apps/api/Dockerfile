# syntax=docker/dockerfile:1.7

FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src

# Copy solution + project files first to exploit Docker layer caching on restore.
COPY SharedCookbook.sln Directory.Build.props ./
COPY src/SharedCookbook.Api/SharedCookbook.Api.csproj src/SharedCookbook.Api/
COPY src/SharedCookbook.Domain/SharedCookbook.Domain.csproj src/SharedCookbook.Domain/
COPY src/SharedCookbook.Infrastructure/SharedCookbook.Infrastructure.csproj src/SharedCookbook.Infrastructure/
COPY tests/SharedCookbook.Api.Tests/SharedCookbook.Api.Tests.csproj tests/SharedCookbook.Api.Tests/
COPY tests/SharedCookbook.Domain.Tests/SharedCookbook.Domain.Tests.csproj tests/SharedCookbook.Domain.Tests/
COPY tests/SharedCookbook.Infrastructure.Tests/SharedCookbook.Infrastructure.Tests.csproj tests/SharedCookbook.Infrastructure.Tests/
RUN dotnet restore src/SharedCookbook.Api/SharedCookbook.Api.csproj

COPY src/ src/
RUN dotnet publish src/SharedCookbook.Api/SharedCookbook.Api.csproj -c Release -o /app --no-restore

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
ENTRYPOINT ["dotnet", "SharedCookbook.Api.dll"]
