"""Transaction scopes own their connection; explicit raw ownership stays supported."""
from contextlib import closing
import gc
import sqlite3

import pytest

from backend import db


def assert_closed(connection):
    with pytest.raises(sqlite3.ProgrammingError, match='closed'):
        connection.execute('SELECT 1')


def test_scope_commits_and_closes_without_garbage_collection(tmp_path):
    library = tmp_path / 'library'
    with db.connect(library) as connection:
        assert isinstance(connection, sqlite3.Connection)
        assert connection.row_factory is sqlite3.Row
        assert connection.execute('PRAGMA foreign_keys').fetchone()[0] == 1
        assert connection.execute('PRAGMA busy_timeout').fetchone()[0] == db.BUSY_TIMEOUT_SECONDS * 1000
        connection.execute('CREATE TABLE fixture (value TEXT)')
        connection.execute('INSERT INTO fixture VALUES (?)', ('unchanged original',))
    assert_closed(connection)
    with db.connect(library) as verifier:
        assert verifier.execute('SELECT value FROM fixture').fetchone()['value'] == 'unchanged original'
    assert_closed(verifier)


def test_exception_rolls_back_and_closes(tmp_path):
    library = tmp_path / 'library'
    with db.connect(library) as setup:
        setup.execute('CREATE TABLE fixture (value TEXT)')
    with pytest.raises(RuntimeError, match='synthetic failure'):
        with db.connect(library) as connection:
            connection.execute('BEGIN IMMEDIATE')
            connection.execute("INSERT INTO fixture VALUES ('uncommitted')")
            raise RuntimeError('synthetic failure')
    assert_closed(connection)
    with db.connect(library) as verifier:
        assert verifier.execute('SELECT COUNT(*) FROM fixture').fetchone()[0] == 0


def test_commit_error_rolls_back_then_closes(tmp_path):
    library = tmp_path / 'library'
    with db.connect(library) as setup:
        setup.executescript('CREATE TABLE parent(id PRIMARY KEY); CREATE TABLE child(id REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED);')
    with pytest.raises(sqlite3.IntegrityError):
        with db.connect(library) as connection:
            connection.execute('INSERT INTO child VALUES (999)')
    assert_closed(connection)
    with db.connect(library) as verifier:
        assert verifier.execute('SELECT COUNT(*) FROM child').fetchone()[0] == 0


def test_raw_connection_and_closing_do_not_implicitly_commit(tmp_path):
    library = tmp_path / 'library'
    connection = db.connect(library)
    connection.execute('CREATE TABLE fixture (value TEXT)')
    connection.execute("INSERT INTO fixture VALUES ('committed')")
    connection.commit()
    connection.execute("INSERT INTO fixture VALUES ('rolled back by close')")
    connection.close()
    connection.close()
    with closing(db.connect(library)) as owned:
        assert owned.execute('SELECT value FROM fixture').fetchall()[0][0] == 'committed'
        owned.execute("INSERT INTO fixture VALUES ('not committed by closing')")
    assert_closed(owned)
    with closing(db.connect(library)) as connection, connection:
        assert connection.execute('SELECT COUNT(*) FROM fixture').fetchone()[0] == 1
        connection.execute("INSERT INTO fixture VALUES ('committed by transaction context')")
    assert_closed(connection)


def test_nested_scopes_close_only_outer_owner_and_keep_sqlite_transactions(tmp_path):
    library = tmp_path / 'library'
    with db.connect(library) as connection:
        connection.execute('CREATE TABLE fixture (value TEXT)')
        with connection:
            connection.execute("INSERT INTO fixture VALUES ('inner')")
        assert connection.execute('SELECT value FROM fixture').fetchone()[0] == 'inner'
        connection.execute("INSERT INTO fixture VALUES ('outer')")
    assert_closed(connection)
    with db.connect(library) as verifier:
        assert verifier.execute('SELECT COUNT(*) FROM fixture').fetchone()[0] == 2


def test_early_return_closes_connection_even_when_retained(tmp_path):
    held = []
    def read_once():
        with db.connect(tmp_path / 'library') as connection:
            held.append(connection)
            return connection.execute('SELECT 42').fetchone()[0]
    assert read_once() == 42
    assert_closed(held[0])


def test_repeated_scopes_release_windows_files_without_gc(tmp_path):
    library = tmp_path / 'library'
    enabled = gc.isenabled()
    gc.disable()
    held = []
    try:
        db.init_db(library)
        for _ in range(40):
            with db.connect(library) as connection:
                held.append(connection)
                assert connection.execute('PRAGMA journal_mode').fetchone()[0] == 'wal'
        for connection in held:
            assert_closed(connection)
        # Retained Python objects cannot keep database handles open on Windows.
        moved = library.with_name('moved-library')
        library.rename(moved)
        moved.rename(library)
    finally:
        for connection in held:
            connection.close()
        if enabled:
            gc.enable()


def test_setup_failure_closes_allocated_connection(tmp_path, monkeypatch):
    created = []
    real_connect = sqlite3.connect
    class RejectForeignKeys(sqlite3.Connection):
        def execute(self, sql, *args, **kwargs):
            if sql == 'PRAGMA foreign_keys = ON':
                raise sqlite3.OperationalError('synthetic initialization error')
            return super().execute(sql, *args, **kwargs)
    def broken(*args, **kwargs):
        kwargs['factory'] = RejectForeignKeys
        connection = real_connect(*args, **kwargs)
        created.append(connection)
        return connection
    monkeypatch.setattr(db.sqlite3, 'connect', broken)
    with pytest.raises(sqlite3.OperationalError, match='initialization error'):
        db.connect(tmp_path / 'library')
    assert_closed(created[0])


def test_repository_reads_release_all_owned_connections_without_collecting(tmp_path, monkeypatch):
    from backend.repositories import ItemRepository
    from backend.services.agent_repository import AgentRepository
    from backend.services.generation_jobs import GenerationJobRepository
    library = tmp_path / 'library'
    allocated = []
    real_connect = sqlite3.connect
    def tracked(*args, **kwargs):
        connection = real_connect(*args, **kwargs)
        allocated.append(connection)
        return connection
    monkeypatch.setattr(db.sqlite3, 'connect', tracked)
    ItemRepository(library).list_items()
    GenerationJobRepository(library).list_jobs()
    AgentRepository(library).list_conversations()
    assert allocated
    for connection in allocated:
        assert_closed(connection)


def test_inner_rollback_preserves_outer_owner_until_outer_exit(tmp_path):
    library = tmp_path / 'library'
    with db.connect(library) as connection:
        connection.execute('CREATE TABLE fixture (value TEXT)')
        with pytest.raises(RuntimeError):
            with connection:
                connection.execute("INSERT INTO fixture VALUES ('inner rollback')")
                raise RuntimeError('synthetic inner failure')
        assert connection.execute('SELECT COUNT(*) FROM fixture').fetchone()[0] == 0
        connection.execute("INSERT INTO fixture VALUES ('outer commit')")
    assert_closed(connection)
    with db.connect(library) as verifier:
        assert verifier.execute('SELECT value FROM fixture').fetchone()[0] == 'outer commit'
