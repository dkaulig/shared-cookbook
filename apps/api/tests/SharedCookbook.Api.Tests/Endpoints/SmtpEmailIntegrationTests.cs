using System.Net;
using System.Net.Http.Json;
using System.Net.Sockets;
using SharedCookbook.Api.Endpoints;
using SharedCookbook.Api.Tests.Infrastructure;
using SharedCookbook.Domain.Entities;
using SharedCookbook.Infrastructure.Persistence;
using Microsoft.AspNetCore.Identity;
using Microsoft.Extensions.DependencyInjection;
using netDumbster.smtp;
using Xunit;

namespace SharedCookbook.Api.Tests.Endpoints;

/// <summary>
/// PF3 — end-to-end proof that the real SmtpEmailSender path actually
/// delivers a mail when the app is configured with SMTP credentials.
/// Spins up a netDumbster fake on an ephemeral port and points the
/// WebApplicationFactory's Smtp:* config at it, so <c>Program.cs</c>'s
/// conditional DI branch resolves to <c>SmtpEmailSender</c> (not the
/// FakeEmailSender spy).
///
/// Covered here: password-reset only — the app-invite + group-invite
/// call-site tests live next to their respective endpoint test files
/// (InviteEndpointsTests / GroupEndpointsTests).
/// </summary>
public class SmtpEmailIntegrationTests : IAsyncLifetime
{
    private SimpleSmtpServer _smtp = null!;
    private int _port;
    private SharedCookbookWebApplicationFactory _factory = null!;
    private HttpClient _client = null!;

    public async Task InitializeAsync()
    {
        _port = GetFreePort();
        _smtp = SimpleSmtpServer.Start(_port);
        _factory = new SharedCookbookWebApplicationFactory()
            .WithSmtpConfig(
                host: "127.0.0.1",
                fromAddress: "no-reply@familien-kochbuch.test",
                port: _port,
                useStartTls: false)
            .WithoutFakeEmailSender();
        await _factory.InitializeAsync();
        _client = _factory.CreateRateLimitBypassingClient(
            new Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactoryClientOptions { HandleCookies = true });
    }

    public async Task DisposeAsync()
    {
        _client.Dispose();
        await _factory.DisposeAsync();
        _smtp.Stop();
    }

    private static int GetFreePort()
    {
        var listener = new TcpListener(System.Net.IPAddress.Loopback, 0);
        listener.Start();
        var port = ((System.Net.IPEndPoint)listener.LocalEndpoint).Port;
        listener.Stop();
        return port;
    }

    private async Task SeedUserAsync(string email, string password)
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        db.Users.RemoveRange(db.Users.Where(u => u.Email == email));
        await db.SaveChangesAsync();

        var users = scope.ServiceProvider.GetRequiredService<UserManager<User>>();
        var user = new User();
        user.SetEmail(email);
        user.SetDisplayName(email.Split('@')[0]);
        user.EmailConfirmed = true;
        var result = await users.CreateAsync(user, password);
        if (!result.Succeeded)
            throw new InvalidOperationException(
                string.Join(", ", result.Errors.Select(e => e.Description)));
    }

    [Fact]
    public async Task PasswordResetRequest_Routes_Through_Real_Smtp_Sender_And_Delivers_Mail()
    {
        await SeedUserAsync("smtp.integration@example.com", "AltesPasswort1!");

        var response = await _client.PostAsJsonAsync(
            "/api/auth/password-reset-request",
            new AuthEndpoints.PasswordResetRequestBody("smtp.integration@example.com"));

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        Assert.Equal(1, _smtp.ReceivedEmailCount);
        var msg = _smtp.ReceivedEmail[0];
        Assert.Equal("smtp.integration@example.com", msg.ToAddresses[0].Address);
        Assert.Contains("<no-reply@familien-kochbuch.test>", msg.Headers["From"]);
    }
}
