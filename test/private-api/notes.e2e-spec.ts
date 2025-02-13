/*
 * SPDX-FileCopyrightText: 2021 The HedgeDoc developers (see AUTHORS file)
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { INestApplication } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { promises as fs } from 'fs';
import { join } from 'path';
import request from 'supertest';

import { PrivateApiModule } from '../../src/api/private/private-api.module';
import { AuthModule } from '../../src/auth/auth.module';
import { AuthConfig } from '../../src/config/auth.config';
import appConfigMock from '../../src/config/mock/app.config.mock';
import authConfigMock from '../../src/config/mock/auth.config.mock';
import customizationConfigMock from '../../src/config/mock/customization.config.mock';
import externalConfigMock from '../../src/config/mock/external-services.config.mock';
import mediaConfigMock from '../../src/config/mock/media.config.mock';
import { NotInDBError } from '../../src/errors/errors';
import { GroupsModule } from '../../src/groups/groups.module';
import { IdentityService } from '../../src/identity/identity.service';
import { LoggerModule } from '../../src/logger/logger.module';
import { MediaService } from '../../src/media/media.service';
import { NotesModule } from '../../src/notes/notes.module';
import { NotesService } from '../../src/notes/notes.service';
import { PermissionsModule } from '../../src/permissions/permissions.module';
import { User } from '../../src/users/user.entity';
import { UsersModule } from '../../src/users/users.module';
import { UsersService } from '../../src/users/users.service';
import { setupSessionMiddleware } from '../../src/utils/session';

describe('Notes', () => {
  let app: INestApplication;
  let notesService: NotesService;
  let mediaService: MediaService;
  let identityService: IdentityService;
  let user: User;
  let user2: User;
  let content: string;
  let forbiddenNoteId: string;
  let uploadPath: string;
  let testImage: Buffer;
  let agent: request.SuperAgentTest;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [
            mediaConfigMock,
            appConfigMock,
            authConfigMock,
            customizationConfigMock,
            externalConfigMock,
          ],
        }),
        PrivateApiModule,
        NotesModule,
        PermissionsModule,
        GroupsModule,
        TypeOrmModule.forRoot({
          type: 'sqlite',
          database: './hedgedoc-e2e-private-notes.sqlite',
          autoLoadEntities: true,
          synchronize: true,
          dropSchema: true,
        }),
        LoggerModule,
        AuthModule,
        UsersModule,
      ],
    }).compile();

    const config = moduleRef.get<ConfigService>(ConfigService);
    forbiddenNoteId = config.get('appConfig').forbiddenNoteIds[0];
    uploadPath = config.get('mediaConfig').backend.filesystem.uploadPath;
    app = moduleRef.createNestApplication();
    const authConfig = config.get('authConfig') as AuthConfig;
    setupSessionMiddleware(app, authConfig);
    await app.init();
    notesService = moduleRef.get(NotesService);
    mediaService = moduleRef.get(MediaService);
    identityService = moduleRef.get(IdentityService);
    const userService = moduleRef.get(UsersService);
    user = await userService.createUser('hardcoded', 'Testy');
    await identityService.createLocalIdentity(user, 'test');
    user2 = await userService.createUser('hardcoded2', 'Max Mustermann');
    await identityService.createLocalIdentity(user2, 'test');
    content = 'This is a test note.';
    testImage = await fs.readFile('test/public-api/fixtures/test.png');
    agent = request.agent(app.getHttpServer());
    await agent
      .post('/auth/local/login')
      .send({ username: 'hardcoded', password: 'test' })
      .expect(201);
  });

  it('POST /notes', async () => {
    const response = await agent
      .post('/notes')
      .set('Content-Type', 'text/markdown')
      .send(content)
      .expect('Content-Type', /json/)
      .expect(201);
    expect(response.body.metadata?.id).toBeDefined();
    expect(
      await notesService.getNoteContent(
        await notesService.getNoteByIdOrAlias(response.body.metadata.id),
      ),
    ).toEqual(content);
  });

  describe('GET /notes/{note}', () => {
    it('works with an existing note', async () => {
      // check if we can succefully get a note that exists
      await notesService.createNote(content, 'test1', user);
      const response = await agent
        .get('/notes/test1')
        .expect('Content-Type', /json/)
        .expect(200);
      expect(response.body.content).toEqual(content);
    });
    it('fails with an non-existing note', async () => {
      // check if a missing note correctly returns 404
      await agent
        .get('/notes/i_dont_exist')
        .expect('Content-Type', /json/)
        .expect(404);
    });
  });

  describe('POST /notes/{note}', () => {
    it('works with a non-existing alias', async () => {
      const response = await agent
        .post('/notes/test2')
        .set('Content-Type', 'text/markdown')
        .send(content)
        .expect('Content-Type', /json/)
        .expect(201);
      expect(response.body.metadata?.id).toBeDefined();
      return expect(
        await notesService.getNoteContent(
          await notesService.getNoteByIdOrAlias(response.body.metadata?.id),
        ),
      ).toEqual(content);
    });

    it('fails with a forbidden alias', async () => {
      await agent
        .post(`/notes/${forbiddenNoteId}`)
        .set('Content-Type', 'text/markdown')
        .send(content)
        .expect('Content-Type', /json/)
        .expect(400);
    });

    it('fails with a existing alias', async () => {
      await agent
        .post('/notes/test2')
        .set('Content-Type', 'text/markdown')
        .send(content)
        .expect('Content-Type', /json/)
        .expect(400);
    });
  });

  describe('DELETE /notes/{note}', () => {
    describe('works', () => {
      it('with an existing alias and keepMedia false', async () => {
        const noteId = 'test3';
        const note = await notesService.createNote(content, noteId, user);
        await mediaService.saveFile(testImage, user, note);
        await agent
          .delete(`/notes/${noteId}`)
          .set('Content-Type', 'application/json')
          .send({
            keepMedia: false,
          })
          .expect(204);
        await expect(notesService.getNoteByIdOrAlias(noteId)).rejects.toEqual(
          new NotInDBError(`Note with id/alias '${noteId}' not found.`),
        );
        expect(await mediaService.listUploadsByUser(user)).toHaveLength(0);
        await fs.rmdir(uploadPath);
      });
      it('with an existing alias and keepMedia true', async () => {
        const noteId = 'test3a';
        const note = await notesService.createNote(content, noteId, user);
        const url = await mediaService.saveFile(testImage, user, note);
        await agent
          .delete(`/notes/${noteId}`)
          .set('Content-Type', 'application/json')
          .send({
            keepMedia: true,
          })
          .expect(204);
        await expect(notesService.getNoteByIdOrAlias(noteId)).rejects.toEqual(
          new NotInDBError(`Note with id/alias '${noteId}' not found.`),
        );
        expect(await mediaService.listUploadsByUser(user)).toHaveLength(1);
        // Remove /upload/ from path as we just need the filename.
        const fileName = url.replace('/uploads/', '');
        // delete the file afterwards
        await fs.unlink(join(uploadPath, fileName));
        await fs.rmdir(uploadPath);
      });
    });
    it('fails with a forbidden alias', async () => {
      await agent.delete(`/notes/${forbiddenNoteId}`).expect(400);
    });
    it('fails with a non-existing alias', async () => {
      await agent.delete('/notes/i_dont_exist').expect(404);
    });
  });

  describe('GET /notes/{note}/revisions', () => {
    it('works with existing alias', async () => {
      await notesService.createNote(content, 'test4', user);
      const response = await agent
        .get('/notes/test4/revisions')
        .expect('Content-Type', /json/)
        .expect(200);
      expect(response.body).toHaveLength(1);
    });

    it('fails with a forbidden alias', async () => {
      await agent.get(`/notes/${forbiddenNoteId}/revisions`).expect(400);
    });

    it('fails with non-existing alias', async () => {
      // check if a missing note correctly returns 404
      await agent
        .get('/notes/i_dont_exist/revisions')
        .expect('Content-Type', /json/)
        .expect(404);
    });
  });

  describe('DELETE /notes/{note}/revisions', () => {
    it('works with an existing alias', async () => {
      const noteId = 'test8';
      const note = await notesService.createNote(content, noteId, user);
      await notesService.updateNote(note, 'update');
      const responseBeforeDeleting = await agent
        .get('/notes/test8/revisions')
        .expect('Content-Type', /json/)
        .expect(200);
      expect(responseBeforeDeleting.body).toHaveLength(2);
      await agent
        .delete(`/notes/${noteId}/revisions`)
        .set('Content-Type', 'application/json')
        .expect(204);
      const responseAfterDeleting = await agent
        .get('/notes/test8/revisions')
        .expect('Content-Type', /json/)
        .expect(200);
      expect(responseAfterDeleting.body).toHaveLength(1);
    });
    it('fails with a forbidden alias', async () => {
      await agent.delete(`/notes/${forbiddenNoteId}/revisions`).expect(400);
    });
    it('fails with non-existing alias', async () => {
      // check if a missing note correctly returns 404
      await agent
        .delete('/notes/i_dont_exist/revisions')
        .expect('Content-Type', /json/)
        .expect(404);
    });
  });

  describe('GET /notes/{note}/revisions/{revision-id}', () => {
    it('works with an existing alias', async () => {
      const note = await notesService.createNote(content, 'test5', user);
      const revision = await notesService.getLatestRevision(note);
      const response = await agent
        .get(`/notes/test5/revisions/${revision.id}`)
        .expect('Content-Type', /json/)
        .expect(200);
      expect(response.body.content).toEqual(content);
    });
    it('fails with a forbidden alias', async () => {
      await agent.get(`/notes/${forbiddenNoteId}/revisions/1`).expect(400);
    });
    it('fails with non-existing alias', async () => {
      // check if a missing note correctly returns 404
      await agent
        .get('/notes/i_dont_exist/revisions/1')
        .expect('Content-Type', /json/)
        .expect(404);
    });
  });

  describe('GET /notes/{note}/media', () => {
    it('works', async () => {
      const alias = 'test6';
      const extraAlias = 'test7';
      const note1 = await notesService.createNote(content, alias, user);
      const note2 = await notesService.createNote(content, extraAlias, user);
      const response = await agent
        .get(`/notes/${alias}/media/`)
        .expect('Content-Type', /json/)
        .expect(200);
      expect(response.body).toHaveLength(0);

      const testImage = await fs.readFile('test/private-api/fixtures/test.png');
      const url0 = await mediaService.saveFile(testImage, user, note1);
      const url1 = await mediaService.saveFile(testImage, user, note2);

      const responseAfter = await agent
        .get(`/notes/${alias}/media/`)
        .expect('Content-Type', /json/)
        .expect(200);
      expect(responseAfter.body).toHaveLength(1);
      expect(responseAfter.body[0].url).toEqual(url0);
      expect(responseAfter.body[0].url).not.toEqual(url1);
      for (const fileUrl of [url0, url1]) {
        const fileName = fileUrl.replace('/uploads/', '');
        // delete the file afterwards
        await fs.unlink(join(uploadPath, fileName));
      }
      await fs.rmdir(uploadPath, { recursive: true });
    });
    it('fails, when note does not exist', async () => {
      await agent
        .get(`/notes/i_dont_exist/media/`)
        .expect('Content-Type', /json/)
        .expect(404);
    });
    it("fails, when user can't read note", async () => {
      const alias = 'test11';
      await notesService.createNote('This is a test note.', alias, user2);
      await agent
        .get(`/notes/${alias}/media/`)
        .expect('Content-Type', /json/)
        .expect(401);
    });
  });

  afterAll(async () => {
    await app.close();
  });
});
