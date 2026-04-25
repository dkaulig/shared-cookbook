using System.Collections.Concurrent;
using SharedCookbook.Infrastructure.Services;

namespace SharedCookbook.Api.Tests.Infrastructure;

/// <summary>
/// Spy <see cref="IEmailSender"/> that captures outgoing emails so the
/// integration tests can assert on + follow the generated URL. Covers
/// all three flows: password-reset, app-invite, group-invite.
///
/// When <see cref="ThrowOnSend"/> is set the next <c>Send*Async</c> call
/// throws — letting callers verify the graceful-fallback path (endpoint
/// still returns 2xx even when mail delivery fails).
/// </summary>
public class FakeEmailSender : IEmailSender
{
    public record Sent(string ToEmail, string DisplayName, string ResetUrl);
    public record AppInviteSent(string ToEmail, string InviterDisplayName, string AcceptUrl, string? PersonalNote);
    public record GroupInviteSent(string ToEmail, string InviterDisplayName, string GroupName, string AcceptUrl);

    private readonly ConcurrentQueue<Sent> _messages = new();
    private readonly ConcurrentQueue<AppInviteSent> _appInvites = new();
    private readonly ConcurrentQueue<GroupInviteSent> _groupInvites = new();

    public IReadOnlyList<Sent> Messages => _messages.ToArray();
    public IReadOnlyList<AppInviteSent> AppInvites => _appInvites.ToArray();
    public IReadOnlyList<GroupInviteSent> GroupInvites => _groupInvites.ToArray();

    public Sent? Last => _messages.LastOrDefault();
    public AppInviteSent? LastAppInvite => _appInvites.LastOrDefault();
    public GroupInviteSent? LastGroupInvite => _groupInvites.LastOrDefault();

    /// <summary>When set, the next Send* call throws before enqueueing.
    /// Cleared after firing once so subsequent calls record normally.</summary>
    public Exception? ThrowOnSend { get; set; }

    public void Clear()
    {
        _messages.Clear();
        _appInvites.Clear();
        _groupInvites.Clear();
        ThrowOnSend = null;
    }

    public Task SendPasswordResetAsync(
        string toEmail,
        string displayName,
        string resetUrl,
        CancellationToken ct = default)
    {
        ThrowIfSet();
        _messages.Enqueue(new Sent(toEmail, displayName, resetUrl));
        return Task.CompletedTask;
    }

    public Task SendAppInviteAsync(
        string toEmail,
        string inviterDisplayName,
        string acceptUrl,
        string? personalNote,
        CancellationToken ct = default)
    {
        ThrowIfSet();
        _appInvites.Enqueue(new AppInviteSent(toEmail, inviterDisplayName, acceptUrl, personalNote));
        return Task.CompletedTask;
    }

    public Task SendGroupInviteAsync(
        string toEmail,
        string inviterDisplayName,
        string groupName,
        string acceptUrl,
        CancellationToken ct = default)
    {
        ThrowIfSet();
        _groupInvites.Enqueue(new GroupInviteSent(toEmail, inviterDisplayName, groupName, acceptUrl));
        return Task.CompletedTask;
    }

    private void ThrowIfSet()
    {
        if (ThrowOnSend is { } ex)
        {
            ThrowOnSend = null;
            throw ex;
        }
    }
}
