using System.Collections.Concurrent;
using FamilienKochbuch.Infrastructure.Services;

namespace FamilienKochbuch.Api.Tests.Infrastructure;

/// <summary>
/// Spy <see cref="IEmailSender"/> that captures outgoing emails so
/// password-reset tests can assert on + follow the generated URL.
/// </summary>
public class FakeEmailSender : IEmailSender
{
    public record Sent(string ToEmail, string DisplayName, string ResetUrl);

    private readonly ConcurrentQueue<Sent> _messages = new();

    public IReadOnlyList<Sent> Messages => _messages.ToArray();

    public Sent? Last => _messages.LastOrDefault();

    public void Clear() => _messages.Clear();

    public Task SendPasswordResetAsync(
        string toEmail,
        string displayName,
        string resetUrl,
        CancellationToken ct = default)
    {
        _messages.Enqueue(new Sent(toEmail, displayName, resetUrl));
        return Task.CompletedTask;
    }
}
