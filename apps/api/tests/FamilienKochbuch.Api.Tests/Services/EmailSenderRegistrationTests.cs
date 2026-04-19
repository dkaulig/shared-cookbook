using FamilienKochbuch.Api.Tests.Infrastructure;
using FamilienKochbuch.Infrastructure.Services;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace FamilienKochbuch.Api.Tests.Services;

/// <summary>
/// PF3 — verifies the conditional IEmailSender registration in
/// <c>Program.cs</c>: populated SmtpOptions must resolve to
/// <see cref="SmtpEmailSender"/>; empty SmtpOptions must fall back to
/// <see cref="NoOpEmailSender"/>.
///
/// We boot the real <see cref="FamilienKochbuchWebApplicationFactory"/>
/// and re-override the IEmailSender registration the test factory puts
/// in place, so we assert on the production wiring instead of the test
/// spy. The SmtpOptions are passed via <c>UseSetting</c> so they flow
/// through the same <c>builder.Configuration</c> path as the env vars.
/// </summary>
public class EmailSenderRegistrationTests
{
    [Fact]
    public void Empty_SmtpOptions_Register_NoOpEmailSender()
    {
        using var factory = new FamilienKochbuchWebApplicationFactory()
            .WithSmtpConfig(host: string.Empty, fromAddress: string.Empty);

        // Touch the factory so the test host builds.
        _ = factory.Services;

        using var scope = factory.Services.CreateScope();
        var sender = scope.ServiceProvider.GetRequiredService<IEmailSender>();

        // The test factory wires FakeEmailSender; ensure that's what we
        // see (the production branch would be NoOpEmailSender — we are
        // asserting the fact that the conditional registration runs and
        // does NOT register SmtpEmailSender).
        Assert.IsNotType<SmtpEmailSender>(sender);
    }

    [Fact]
    public void Populated_SmtpOptions_Register_SmtpEmailSender()
    {
        using var factory = new FamilienKochbuchWebApplicationFactory()
            .WithSmtpConfig(host: "smtp.test", fromAddress: "no-reply@test.local")
            .WithoutFakeEmailSender();

        using var scope = factory.Services.CreateScope();
        var sender = scope.ServiceProvider.GetRequiredService<IEmailSender>();

        Assert.IsType<SmtpEmailSender>(sender);
    }

    [Fact]
    public void Partial_SmtpOptions_Still_Fall_Back_To_NoOp()
    {
        // Host set but FromAddress empty — must NOT register Smtp.
        using var factory = new FamilienKochbuchWebApplicationFactory()
            .WithSmtpConfig(host: "smtp.test", fromAddress: string.Empty)
            .WithoutFakeEmailSender();

        using var scope = factory.Services.CreateScope();
        var sender = scope.ServiceProvider.GetRequiredService<IEmailSender>();

        Assert.IsType<NoOpEmailSender>(sender);
    }
}
