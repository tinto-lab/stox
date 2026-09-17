from stoxlib import config


def test_load_env_populates_from_project_file(tmp_path, monkeypatch):
    user_file = tmp_path / "user.env"
    project_file = tmp_path / "project.env"
    user_file.write_text("EODHD_API_KEY=from-user\n")
    project_file.write_text("EODHD_API_KEY=from-project\n")

    monkeypatch.setattr(config, "USER_ENV_FILE", user_file)
    monkeypatch.setattr(config, "PROJECT_ENV_FILE", project_file)

    config.load_env()

    import os
    assert os.environ["EODHD_API_KEY"] == "from-project"


def test_load_env_never_overrides_real_env_var(tmp_path, monkeypatch):
    env_file = tmp_path / "project.env"
    env_file.write_text("EODHD_API_KEY=from-file\n")

    monkeypatch.setattr(config, "USER_ENV_FILE", tmp_path / "missing.env")
    monkeypatch.setattr(config, "PROJECT_ENV_FILE", env_file)
    monkeypatch.setenv("EODHD_API_KEY", "shell-exported")

    config.load_env()

    import os
    assert os.environ["EODHD_API_KEY"] == "shell-exported"


def test_load_env_missing_files_do_not_crash(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "USER_ENV_FILE", tmp_path / "nope-user.env")
    monkeypatch.setattr(config, "PROJECT_ENV_FILE", tmp_path / "nope-project.env")

    config.load_env()  # should not raise
