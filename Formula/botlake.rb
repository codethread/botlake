class Botlake < Formula
  desc "Programmable lakes of connected nodes with structured CLI operations"
  homepage "https://github.com/codethread/botlake"
  url "https://github.com/codethread/botlake/archive/refs/tags/v0.3.1.tar.gz"
  sha256 "c77e70554c74b3e33f0f79ff72276f4fb892d8416a1369e3a95d249cc1392571"
  license "MIT"

  depends_on "go" => :build
  depends_on "oven-sh/bun/bun"

  def install
    cd "cli" do
      system "go", "build", *std_go_args(output: bin/"botlake"), "./cmd/botlake"
      system "go", "build", *std_go_args(output: bin/"bl"), "./cmd/bl"
    end
  end

  service do
    run [opt_bin/"botlake", "start"]
    keep_alive true
    environment_variables PATH: std_service_path_env
    log_path var/"log/botlake.log"
    error_log_path var/"log/botlake.log"
  end

  test do
    %w[botlake bl].each do |command|
      output = JSON.parse(shell_output("#{bin}/#{command} --version"))
      assert_equal version.to_s, output.fetch("cli_version")
      assert_equal 1, output.fetch("protocol_version")
      assert_match "Usage:", shell_output("#{bin}/#{command} --help")
    end
    assert_match "compdef _bl bl", shell_output("#{bin}/botlake completions zsh")
  end
end
