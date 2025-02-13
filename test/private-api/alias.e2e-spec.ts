/*
 * SPDX-FileCopyrightText: 2021 The HedgeDoc developers (see AUTHORS file)
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { INestApplication } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import request from 'supertest';

import { PrivateApiModule } from '../../src/api/private/private-api.module';
import { AuthModule } from '../../src/auth/auth.module';
import { AuthConfig } from '../../src/config/auth.config';
import appConfigMock from '../../src/config/mock/app.config.mock';
import authConfigMock from '../../src/config/mock/auth.config.mock';
import customizationConfigMock from '../../src/config/mock/customization.config.mock';
import externalConfigMock from '../../src/config/mock/external-services.config.mock';
import mediaConfigMock from '../../src/config/mock/media.config.mock';
import { GroupsModule } from '../../src/groups/groups.module';
import { IdentityService } from '../../src/identity/identity.service';
import { LoggerModule } from '../../src/logger/logger.module';
import { AliasCreateDto } from '../../src/notes/alias-create.dto';
import { AliasUpdateDto } from '../../src/notes/alias-update.dto';
import { AliasService } from '../../src/notes/alias.service';
import { NotesModule } from '../../src/notes/notes.module';
import { NotesService } from '../../src/notes/notes.service';
import { PermissionsModule } from '../../src/permissions/permissions.module';
import { User } from '../../src/users/user.entity';
import { UsersModule } from '../../src/users/users.module';
import { UsersService } from '../../src/users/users.service';
import { setupSessionMiddleware } from '../../src/utils/session';

describe('Alias', () => {
  let app: INestApplication;
  let aliasService: AliasService;
  let notesService: NotesService;
  let identityService: IdentityService;
  let user: User;
  let content: string;
  let forbiddenNoteId: string;
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
          database: './hedgedoc-e2e-private-alias.sqlite',
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
    app = moduleRef.createNestApplication();
    const authConfig = config.get('authConfig') as AuthConfig;
    setupSessionMiddleware(app, authConfig);
    await app.init();
    aliasService = moduleRef.get(AliasService);
    notesService = moduleRef.get(NotesService);
    identityService = moduleRef.get(IdentityService);
    const userService = moduleRef.get(UsersService);
    user = await userService.createUser('hardcoded', 'Testy');
    await identityService.createLocalIdentity(user, 'test');
    content = 'This is a test note.';
    agent = request.agent(app.getHttpServer());
    await agent
      .post('/auth/local/login')
      .send({ username: 'hardcoded', password: 'test' })
      .expect(201);
  });

  describe('POST /alias', () => {
    const testAlias = 'aliasTest';
    const newAliasDto: AliasCreateDto = {
      noteIdOrAlias: testAlias,
      newAlias: '',
    };
    let publicId = '';
    beforeAll(async () => {
      const note = await notesService.createNote(content, testAlias, user);
      publicId = note.publicId;
    });

    it('create with normal alias', async () => {
      const newAlias = 'normalAlias';
      newAliasDto.newAlias = newAlias;
      const metadata = await agent
        .post(`/alias`)
        .set('Content-Type', 'application/json')
        .send(newAliasDto)
        .expect(201);
      expect(metadata.body.name).toEqual(newAlias);
      expect(metadata.body.primaryAlias).toBeFalsy();
      expect(metadata.body.noteId).toEqual(publicId);
      const note = await agent.get(`/notes/${newAlias}`).expect(200);
      expect(note.body.metadata.aliases).toContain(newAlias);
      expect(note.body.metadata.primaryAlias).toBeTruthy();
      expect(note.body.metadata.id).toEqual(publicId);
    });

    describe('does not create an alias', () => {
      it('because of a forbidden alias', async () => {
        newAliasDto.newAlias = forbiddenNoteId;
        await agent
          .post(`/alias`)
          .set('Content-Type', 'application/json')
          .send(newAliasDto)
          .expect(400);
      });
      it('because of a alias that is a public id', async () => {
        newAliasDto.newAlias = publicId;
        await agent
          .post(`/alias`)
          .set('Content-Type', 'application/json')
          .send(newAliasDto)
          .expect(400);
      });
    });
  });

  describe('PUT /alias/{alias}', () => {
    const testAlias = 'aliasTest2';
    const newAlias = 'normalAlias2';
    const changeAliasDto: AliasUpdateDto = {
      primaryAlias: true,
    };
    let publicId = '';
    beforeAll(async () => {
      const note = await notesService.createNote(content, testAlias, user);
      publicId = note.publicId;
      await aliasService.addAlias(note, newAlias);
    });

    it('updates a note with a normal alias', async () => {
      const metadata = await agent
        .put(`/alias/${newAlias}`)
        .set('Content-Type', 'application/json')
        .send(changeAliasDto)
        .expect(200);
      expect(metadata.body.name).toEqual(newAlias);
      expect(metadata.body.primaryAlias).toBeTruthy();
      expect(metadata.body.noteId).toEqual(publicId);
      const note = await agent.get(`/notes/${newAlias}`).expect(200);
      expect(note.body.metadata.aliases).toContain(newAlias);
      expect(note.body.metadata.primaryAlias).toBeTruthy();
      expect(note.body.metadata.id).toEqual(publicId);
    });

    describe('does not update', () => {
      it('a note with unknown alias', async () => {
        await agent
          .put(`/alias/i_dont_exist`)
          .set('Content-Type', 'application/json')
          .send(changeAliasDto)
          .expect(404);
      });
      it('if the property primaryAlias is false', async () => {
        changeAliasDto.primaryAlias = false;
        await agent
          .put(`/alias/${newAlias}`)
          .set('Content-Type', 'application/json')
          .send(changeAliasDto)
          .expect(400);
      });
    });
  });

  describe('DELETE /alias/{alias}', () => {
    const testAlias = 'aliasTest3';
    const newAlias = 'normalAlias3';
    beforeAll(async () => {
      const note = await notesService.createNote(content, testAlias, user);
      await aliasService.addAlias(note, newAlias);
    });

    it('deletes a normal alias', async () => {
      await agent.delete(`/alias/${newAlias}`).expect(204);
      await agent.get(`/notes/${newAlias}`).expect(404);
    });

    it('does not delete an unknown alias', async () => {
      await agent.delete(`/alias/i_dont_exist`).expect(404);
    });

    it('does not delete an primary alias (if it is not the only one)', async () => {
      const note = await notesService.getNoteByIdOrAlias(testAlias);
      await aliasService.addAlias(note, newAlias);
      await agent.delete(`/alias/${testAlias}`).expect(400);
      await agent.get(`/notes/${newAlias}`).expect(200);
    });

    it('deletes a primary alias (if it is the only one)', async () => {
      await agent.delete(`/alias/${newAlias}`).expect(204);
      await agent.delete(`/alias/${testAlias}`).expect(204);
    });
  });
});
