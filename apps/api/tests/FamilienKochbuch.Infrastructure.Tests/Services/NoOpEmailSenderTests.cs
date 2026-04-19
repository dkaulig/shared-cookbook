using FamilienKochbuch.Infrastructure.Services;
using Microsoft.Extensions.Logging;
using NSubstitute;
using Xunit;

namespace FamilienKochbuch.Infrastructure.Tests.Services;

/// <summary>
/// PF3 — ensures the dev-fallback sender logs one INFO line per message
/// on all three flows, and never surfaces the HTML/plain-text body to
/// the log (subject + recipient only for invites, per the plan §6).
/// </summary>
public class NoOpEmailSenderTests
{
    private static (NoOpEmailSender sender, ILogger<NoOpEmailSender> logger) Create()
    {
        var logger = Substitute.For<ILogger<NoOpEmailSender>>();
        logger.IsEnabled(Arg.Any<LogLevel>()).Returns(true);
        return (new NoOpEmailSender(logger), logger);
    }

    [Fact]
    public async Task SendPasswordResetAsync_Logs_Info_With_Email_And_Url()
    {
        var (sender, logger) = Create();

        await sender.SendPasswordResetAsync(
            toEmail: "user@example.com",
            displayName: "Max",
            resetUrl: "https://app.local/reset-password?token=abc");

        logger.Received(1).Log(
            LogLevel.Information,
            Arg.Any<EventId>(),
            Arg.Is<object>(o => o.ToString()!.Contains("user@example.com")
                                && o.ToString()!.Contains("Max")
                                && o.ToString()!.Contains("https://app.local/reset-password?token=abc")),
            null,
            Arg.Any<Func<object, Exception?, string>>());
    }

    [Fact]
    public async Task SendAppInviteAsync_Logs_Info_With_Recipient_And_Subject_But_No_Url()
    {
        var (sender, logger) = Create();

        await sender.SendAppInviteAsync(
            toEmail: "newbie@example.com",
            inviterDisplayName: "Anna",
            acceptUrl: "https://app.local/signup?invite=xyz",
            personalNote: "freu mich auf dich!");

        logger.Received(1).Log(
            LogLevel.Information,
            Arg.Any<EventId>(),
            Arg.Is<object>(o =>
                o.ToString()!.Contains("newbie@example.com")
                && o.ToString()!.Contains("Anna")
                && o.ToString()!.Contains("Einladung")
                // Accept URL carries the token — must NOT leak into the log.
                && !o.ToString()!.Contains("xyz")
                // Personal note is body content — also must NOT leak.
                && !o.ToString()!.Contains("freu mich auf dich")),
            null,
            Arg.Any<Func<object, Exception?, string>>());
    }

    [Fact]
    public async Task SendGroupInviteAsync_Logs_Info_With_Recipient_GroupName_And_Inviter()
    {
        var (sender, logger) = Create();

        await sender.SendGroupInviteAsync(
            toEmail: "member@example.com",
            inviterDisplayName: "Bernd",
            groupName: "Familie Mustermann",
            acceptUrl: "https://app.local/groups?invite=abc");

        logger.Received(1).Log(
            LogLevel.Information,
            Arg.Any<EventId>(),
            Arg.Is<object>(o =>
                o.ToString()!.Contains("member@example.com")
                && o.ToString()!.Contains("Bernd")
                && o.ToString()!.Contains("Familie Mustermann")
                // Accept URL must NOT leak into the log.
                && !o.ToString()!.Contains("abc")),
            null,
            Arg.Any<Func<object, Exception?, string>>());
    }
}
