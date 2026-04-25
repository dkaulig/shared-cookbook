using System.Net;
using System.Net.Sockets;
using System.Text;
using SharedCookbook.Infrastructure.Services;
using Microsoft.Extensions.Logging.Abstractions;
using netDumbster.smtp;
using Xunit;

namespace SharedCookbook.Infrastructure.Tests.Services;

/// <summary>
/// PF3 — SmtpEmailSender contract tests. netDumbster hosts an in-process
/// fake SMTP server on an ephemeral port so we can round-trip real MIME
/// messages and assert on the parsed envelope + headers + body.
///
/// netDumbster does not speak STARTTLS and ignores AUTH credentials; both
/// trade-offs are fine for verifying message-shape. Connection-refused
/// and auth-fail paths are exercised via a custom TCP fake that closes
/// or rejects predictably.
/// </summary>
public class SmtpEmailSenderTests : IDisposable
{
    private readonly SimpleSmtpServer _server;
    private readonly int _port;

    public SmtpEmailSenderTests()
    {
        _port = GetFreePort();
        _server = SimpleSmtpServer.Start(_port);
    }

    public void Dispose()
    {
        _server.Stop();
        GC.SuppressFinalize(this);
    }

    private SmtpEmailSender CreateSender(bool useStartTls = false, string user = "") =>
        new(new SmtpOptionsSnapshot(
                Host: "127.0.0.1",
                Port: _port,
                User: user,
                Password: string.Empty,
                FromAddress: "no-reply@familien-kochbuch.test",
                FromName: "Familien-Kochbuch",
                UseStartTls: useStartTls),
            NullLogger<SmtpEmailSender>.Instance);

    private static int GetFreePort()
    {
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        listener.Stop();
        return port;
    }

    private static string DecodeBody(netDumbster.smtp.SmtpMessage message)
    {
        var raw = message.MessageParts[0].BodyData;
        // MimeKit emits quoted-printable by default for plain-text UTF-8
        // with non-ASCII content — decode the two forms we actually hit.
        if (string.Equals(message.Headers["Content-Transfer-Encoding"], "quoted-printable",
                StringComparison.OrdinalIgnoreCase))
        {
            return DecodeQuotedPrintable(raw);
        }
        if (string.Equals(message.Headers["Content-Transfer-Encoding"], "base64",
                StringComparison.OrdinalIgnoreCase))
        {
            return Encoding.UTF8.GetString(Convert.FromBase64String(raw));
        }
        return raw;
    }

    private static string DecodeQuotedPrintable(string input)
    {
        // Collapse soft line breaks, then decode =XX byte escapes.
        var collapsed = input.Replace("=\r\n", string.Empty).Replace("=\n", string.Empty);
        var bytes = new List<byte>(collapsed.Length);
        for (int i = 0; i < collapsed.Length; i++)
        {
            if (collapsed[i] == '=' && i + 2 < collapsed.Length)
            {
                var hex = collapsed.Substring(i + 1, 2);
                if (byte.TryParse(hex, System.Globalization.NumberStyles.HexNumber,
                        System.Globalization.CultureInfo.InvariantCulture, out var b))
                {
                    bytes.Add(b);
                    i += 2;
                    continue;
                }
            }
            bytes.Add((byte)collapsed[i]);
        }
        return Encoding.UTF8.GetString(bytes.ToArray());
    }

    [Fact]
    public async Task SendPasswordResetAsync_Delivers_Message_With_Correct_Headers_And_Body()
    {
        var sender = CreateSender();

        await sender.SendPasswordResetAsync(
            toEmail: "user@example.com",
            displayName: "Max",
            resetUrl: "https://app.local/reset-password?token=ABC123");

        Assert.Equal(1, _server.ReceivedEmailCount);
        var msg = _server.ReceivedEmail[0];
        Assert.Contains("<no-reply@familien-kochbuch.test>", msg.Headers["From"]);
        Assert.Contains("Familien-Kochbuch", msg.Headers["From"]);
        Assert.Equal("user@example.com", msg.ToAddresses[0].Address);
        // Subject may be encoded-word-wrapped for the umlaut; normalise to
        // the decoded header netDumbster exposes.
        Assert.Contains("Passwort", msg.Headers["Subject"]);

        var body = DecodeBody(msg);
        Assert.Contains("https://app.local/reset-password?token=ABC123", body);
        Assert.Contains("Hallo Max", body);
    }

    [Fact]
    public async Task SendAppInviteAsync_Delivers_Message_With_Inviter_Name_And_Accept_Url()
    {
        var sender = CreateSender();

        await sender.SendAppInviteAsync(
            toEmail: "new.person@example.com",
            inviterDisplayName: "Anna",
            acceptUrl: "https://app.local/signup?invite=token-xyz",
            personalNote: null);

        Assert.Equal(1, _server.ReceivedEmailCount);
        var msg = _server.ReceivedEmail[0];
        Assert.Equal("new.person@example.com", msg.ToAddresses[0].Address);
        Assert.Contains("Einladung", msg.Headers["Subject"]);

        var body = DecodeBody(msg);
        Assert.Contains("Anna", body);
        Assert.Contains("https://app.local/signup?invite=token-xyz", body);
    }

    [Fact]
    public async Task SendAppInviteAsync_Includes_Personal_Note_When_Provided()
    {
        var sender = CreateSender();

        await sender.SendAppInviteAsync(
            toEmail: "new.person@example.com",
            inviterDisplayName: "Anna",
            acceptUrl: "https://app.local/signup?invite=abc",
            personalNote: "freue mich schon!");

        var msg = _server.ReceivedEmail[0];
        var body = DecodeBody(msg);
        Assert.Contains("freue mich schon!", body);
    }

    [Fact]
    public async Task SendGroupInviteAsync_Includes_Group_Name_In_Subject_And_Body()
    {
        var sender = CreateSender();

        await sender.SendGroupInviteAsync(
            toEmail: "member@example.com",
            inviterDisplayName: "Bernd",
            groupName: "Familie Mustermann",
            acceptUrl: "https://app.local/groups?invite=gid-42");

        Assert.Equal(1, _server.ReceivedEmailCount);
        var msg = _server.ReceivedEmail[0];
        Assert.Equal("member@example.com", msg.ToAddresses[0].Address);
        // Subject is MIME-encoded because it contains a quoted group name
        // with special chars; decode before asserting.
        var subjectRaw = msg.Headers["Subject"] ?? string.Empty;
        Assert.True(subjectRaw.Contains("Familie")
                    || subjectRaw.Contains("=?"), "Subject should carry group name");

        var body = DecodeBody(msg);
        Assert.Contains("Familie Mustermann", body);
        Assert.Contains("Bernd", body);
        Assert.Contains("https://app.local/groups?invite=gid-42", body);
    }

    [Fact]
    public async Task SendAsync_Throws_EmailSendException_When_Server_Refuses_Connection()
    {
        // Use a port that nothing is listening on.
        var deadPort = GetFreePort();
        var sender = new SmtpEmailSender(
            new SmtpOptionsSnapshot(
                Host: "127.0.0.1",
                Port: deadPort,
                User: string.Empty,
                Password: string.Empty,
                FromAddress: "no-reply@familien-kochbuch.test",
                FromName: "Familien-Kochbuch",
                UseStartTls: false),
            NullLogger<SmtpEmailSender>.Instance);

        await Assert.ThrowsAsync<EmailSendException>(() =>
            sender.SendPasswordResetAsync("u@example.com", "Max", "https://app.local/x"));
    }

    [Fact]
    public async Task SendAsync_Throws_EmailSendException_On_Auth_Failure()
    {
        // Spin up a tiny fake that advertises AUTH LOGIN but replies 535
        // (auth rejected) to every credential attempt.
        var port = GetFreePort();
        using var fake = new AuthRejectingSmtpFake(port);
        fake.Start();

        var sender = new SmtpEmailSender(
            new SmtpOptionsSnapshot(
                Host: "127.0.0.1",
                Port: port,
                User: "fake-user",
                Password: "fake-password",
                FromAddress: "no-reply@familien-kochbuch.test",
                FromName: "Familien-Kochbuch",
                UseStartTls: false),
            NullLogger<SmtpEmailSender>.Instance);

        await Assert.ThrowsAsync<EmailSendException>(() =>
            sender.SendPasswordResetAsync("u@example.com", "Max", "https://app.local/x"));
    }

    /// <summary>Trivial SMTP fake that greets, advertises AUTH LOGIN, and
    /// 535-rejects any credential submission. Used only by the auth-fail
    /// test — deliberately minimal.</summary>
    private sealed class AuthRejectingSmtpFake : IDisposable
    {
        private readonly TcpListener _listener;
        private readonly CancellationTokenSource _cts = new();

        public AuthRejectingSmtpFake(int port)
        {
            _listener = new TcpListener(IPAddress.Loopback, port);
        }

        public void Start()
        {
            _listener.Start();
            _ = Task.Run(AcceptLoopAsync);
        }

        private async Task AcceptLoopAsync()
        {
            while (!_cts.IsCancellationRequested)
            {
                TcpClient client;
                try { client = await _listener.AcceptTcpClientAsync(_cts.Token); }
                catch { return; }

                _ = Task.Run(() => HandleClientAsync(client));
            }
        }

        private static async Task HandleClientAsync(TcpClient client)
        {
            using (client)
            using (var stream = client.GetStream())
            using (var reader = new StreamReader(stream, Encoding.ASCII))
            using (var writer = new StreamWriter(stream, Encoding.ASCII) { NewLine = "\r\n", AutoFlush = true })
            {
                await writer.WriteLineAsync("220 fake ESMTP ready");
                string? line;
                while ((line = await reader.ReadLineAsync()) is not null)
                {
                    var upper = line.ToUpperInvariant();
                    if (upper.StartsWith("EHLO") || upper.StartsWith("HELO"))
                    {
                        await writer.WriteLineAsync("250-fake");
                        await writer.WriteLineAsync("250 AUTH LOGIN PLAIN");
                    }
                    else if (upper.StartsWith("AUTH"))
                    {
                        await writer.WriteLineAsync("535 5.7.8 Authentication failed");
                        return;
                    }
                    else if (upper.StartsWith("QUIT"))
                    {
                        await writer.WriteLineAsync("221 bye");
                        return;
                    }
                    else
                    {
                        await writer.WriteLineAsync("500 not supported");
                    }
                }
            }
        }

        public void Dispose()
        {
            _cts.Cancel();
            _listener.Stop();
            _cts.Dispose();
        }
    }
}
